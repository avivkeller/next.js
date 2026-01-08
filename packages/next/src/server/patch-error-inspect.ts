import { findSourceMap as nativeFindSourceMap } from 'module'
import * as path from 'path'
import * as url from 'url'
import type * as util from 'util'
import { SourceMapConsumer as SyncSourceMapConsumer } from 'next/dist/compiled/source-map'
import {
  type ModernSourceMapPayload,
  findApplicableSourceMapPayload,
  ignoreListAnonymousStackFramesIfSandwiched as ignoreListAnonymousStackFramesIfSandwichedGeneric,
  sourceMapIgnoreListsEverything,
} from './lib/source-maps'
import { parseStack, type StackFrame } from './lib/parse-stack'
import { getOriginalCodeFrame } from '../next-devtools/server/shared'
import { workUnitAsyncStorage } from './app-render/work-unit-async-storage.external'
import { dim, italic } from '../lib/picocolors'

/**
 * V8 CallSite interface for structured stack traces.
 * @see https://v8.dev/docs/stack-trace-api
 */
interface CallSite {
  getThis(): unknown
  getTypeName(): string | null
  getFunction(): Function | undefined
  getFunctionName(): string | null
  getMethodName(): string | null
  getFileName(): string | undefined
  getLineNumber(): number | null
  getColumnNumber(): number | null
  getEvalOrigin(): string | undefined
  isToplevel(): boolean
  isEval(): boolean
  isNative(): boolean
  isConstructor(): boolean
  isAsync(): boolean
  isPromiseAll(): boolean
  getPromiseIndex(): number | null
  // V8-specific methods for getting enclosing function location
  // These may not be available in all runtimes (e.g., Bun)
  getEnclosingLineNumber?(): number | null
  getEnclosingColumnNumber?(): number | null
  toString(): string
}

/**
 * Captured stack frame data from V8 CallSite objects.
 * This preserves the structured data so we don't need to parse stack strings later.
 */
interface CapturedFrame {
  /** Function name from getFunctionName() or getMethodName() */
  functionName: string | undefined
  /** Type name from getTypeName() for qualified names like "Foo.bar" */
  typeName: string | undefined
  /** File name from getFileName() */
  fileName: string | undefined
  /** Line number of the call site (1-indexed) */
  lineNumber: number | undefined
  /** Column number of the call site (1-indexed) */
  columnNumber: number | undefined
  /** Line number where the enclosing function is defined (1-indexed), V8-specific */
  enclosingLineNumber: number | undefined
  /** Column number where the enclosing function is defined (1-indexed), V8-specific */
  enclosingColumnNumber: number | undefined
  /** Whether this is an async function call */
  isAsync: boolean
  /** Whether this is a constructor call (new Foo()) */
  isConstructor: boolean
}

/**
 * Captured stack trace information stored in WeakMap keyed by Error object.
 */
interface CapturedStackTrace {
  /** Error name computed at capture time */
  name: string
  /** Captured frames from CallSite objects */
  frames: CapturedFrame[]
}

/**
 * WeakMap to store captured stack trace data keyed by Error object.
 * This allows us to access the structured CallSite data later during inspection
 * without needing to parse the stack string.
 */
const capturedStackTraces = new WeakMap<Error, CapturedStackTrace>()

type FindSourceMapPayload = (
  sourceURL: string
) => ModernSourceMapPayload | undefined
// Find a source map using the bundler's API.
// This is only a fallback for when Node.js fails to due to bugs e.g. https://github.com/nodejs/node/issues/52102
// TODO: Remove once all supported Node.js versions are fixed.
// TODO(veil): Set from Webpack as well
let bundlerFindSourceMapPayload: FindSourceMapPayload = () => undefined

export function setBundlerFindSourceMapImplementation(
  findSourceMapImplementation: FindSourceMapPayload
): void {
  bundlerFindSourceMapPayload = findSourceMapImplementation
}

interface IgnorableStackFrame extends StackFrame {
  ignored: boolean
}

/**
 * Name mappings indexed by generated line number.
 * Each entry is an array of {column, name} sorted by column.
 */
type NameMappingsByLine = Map<number, Array<{ column: number; name: string }>>

type SourceMapCache = Map<
  string,
  null | {
    map: SyncSourceMapConsumer
    payload: ModernSourceMapPayload
    /** Cached name mappings for efficient lookup */
    nameMappings?: NameMappingsByLine
  }
>

function frameToString(
  methodName: string | null,
  sourceURL: string | null,
  line1: number | null,
  column1: number | null
): string {
  let sourceLocation = line1 !== null ? `:${line1}` : ''
  if (column1 !== null && sourceLocation !== '') {
    sourceLocation += `:${column1}`
  }

  let fileLocation: string | null
  if (
    sourceURL !== null &&
    sourceURL.startsWith('file://') &&
    URL.canParse(sourceURL)
  ) {
    // If not relative to CWD, the path is ambiguous to IDEs and clicking will prompt to select the file first.
    // In a multi-app repo, this leads to potentially larger file names but will make clicking snappy.
    // There's no tradeoff for the cases where `dir` in `next dev [dir]` is omitted
    // since relative to cwd is both the shortest and snappiest.
    fileLocation = path.relative(process.cwd(), url.fileURLToPath(sourceURL))
  } else if (sourceURL !== null && sourceURL.startsWith('/')) {
    fileLocation = path.relative(process.cwd(), sourceURL)
  } else {
    fileLocation = sourceURL
  }

  return methodName
    ? `    at ${methodName} (${fileLocation}${sourceLocation})`
    : `    at ${fileLocation}${sourceLocation}`
}

function computeErrorName(error: Error): string {
  // TODO: Node.js seems to use a different algorithm
  // class ReadonlyRequestCookiesError extends Error {}` would read `ReadonlyRequestCookiesError: [...]`
  // in the stack i.e. seems like under certain conditions it favors the constructor name.
  return error.name || 'Error'
}

/**
 * Capture a CallSite object into a plain object for later use.
 */
function captureCallSite(callSite: CallSite): CapturedFrame {
  return {
    functionName:
      callSite.getFunctionName() ?? callSite.getMethodName() ?? undefined,
    typeName: callSite.getTypeName() ?? undefined,
    fileName: callSite.getFileName() ?? undefined,
    lineNumber: callSite.getLineNumber() ?? undefined,
    columnNumber: callSite.getColumnNumber() ?? undefined,
    // These V8-specific methods may not exist in all runtimes (e.g., Bun)
    enclosingLineNumber: callSite.getEnclosingLineNumber?.() ?? undefined,
    enclosingColumnNumber: callSite.getEnclosingColumnNumber?.() ?? undefined,
    isAsync: callSite.isAsync(),
    isConstructor: callSite.isConstructor(),
  }
}

function prepareUnsourcemappedStackTrace(
  error: Error,
  structuredStackTrace: CallSite[]
): string {
  const name = computeErrorName(error)
  const message = error.message || ''

  // Capture the structured stack trace data for later source mapping
  const frames = structuredStackTrace.map(captureCallSite)
  capturedStackTraces.set(error, { name, frames })

  let stack = name + ': ' + message
  for (let i = 0; i < structuredStackTrace.length; i++) {
    stack += '\n    at ' + structuredStackTrace[i].toString()
  }
  return stack
}

function shouldIgnoreListGeneratedFrame(file: string): boolean {
  return file.startsWith('node:') || file.includes('node_modules')
}

function shouldIgnoreListOriginalFrame(file: string): boolean {
  return file.includes('node_modules')
}

/**
 * Build a cached lookup structure for name mappings from a source map.
 * This allows efficient name lookups without iterating all mappings each time.
 */
function buildNameMappings(
  sourceMapConsumer: SyncSourceMapConsumer
): NameMappingsByLine {
  const nameMappings: NameMappingsByLine = new Map()

  sourceMapConsumer.eachMapping((mapping) => {
    if (!mapping.name) return

    let lineEntries = nameMappings.get(mapping.generatedLine)
    if (!lineEntries) {
      lineEntries = []
      nameMappings.set(mapping.generatedLine, lineEntries)
    }
    lineEntries.push({ column: mapping.generatedColumn, name: mapping.name })
  })

  // Sort each line's entries by column for efficient searching
  for (const entries of nameMappings.values()) {
    entries.sort((a, b) => a.column - b.column)
  }

  return nameMappings
}

/**
 * Find the closest name near the given position on the same line.
 * Searches both forward (for `function foo`) and backward (for `const foo = () =>`).
 */
function findNameAtPosition(
  nameMappings: NameMappingsByLine,
  line: number,
  column: number
): string | undefined {
  const lineEntries = nameMappings.get(line)
  if (!lineEntries || lineEntries.length === 0) return undefined

  // Search window: function identifiers are typically within ~30 chars
  // Forward: `function foo` or `async function foo`
  // Backward: `const foo = () =>` where enclosing points to `()`
  const searchRadius = 30

  let closestName: string | undefined
  let closestDistance = Infinity

  for (const entry of lineEntries) {
    const distance = Math.abs(entry.column - column)
    if (distance <= searchRadius && distance < closestDistance) {
      closestDistance = distance
      closestName = entry.name
    }
  }

  return closestName
}

/**
 * Resolve the original function name using V8's enclosing function position.
 *
 * This uses the enclosingLineNumber/enclosingColumnNumber from V8 CallSite objects
 * to find where the function was defined in generated code, then searches for a
 * name mapping near that position in the source map.
 *
 * The challenge is that V8 points to the start of the function (e.g., `function` keyword),
 * but the name mapping in source maps is typically at the identifier position. We search
 * forward from the enclosing position to find the nearest name.
 *
 * @param capturedFrame - The captured frame with enclosing position info
 * @param nameMappings - Cached name mappings from the source map
 * @param mangledName - The mangled function name from the stack trace (already formatted with typeName and async)
 * @returns The resolved function name, or the mangled name if resolution fails
 */
function resolveFunctionName(
  capturedFrame: CapturedFrame,
  nameMappings: NameMappingsByLine | undefined,
  mangledName: string
): string {
  // Try to find the original function name using the enclosing function position
  // This is only available in V8 (Node.js), not in Bun (JSC)
  if (
    capturedFrame.enclosingLineNumber !== undefined &&
    capturedFrame.enclosingColumnNumber !== undefined &&
    nameMappings
  ) {
    const foundName = findNameAtPosition(
      nameMappings,
      capturedFrame.enclosingLineNumber,
      capturedFrame.enclosingColumnNumber - 1 // Convert to 0-indexed
    )

    if (foundName) {
      // Found the original function name in the source map
      // Format it with typeName and async/constructor prefixes to match the mangledName format
      return formatMethodName(
        foundName,
        capturedFrame.typeName,
        capturedFrame.isAsync,
        capturedFrame.isConstructor
      )
    }
  }

  // Fallback: clean up the mangled name (which already has typeName and async)
  let methodName = mangledName
  if (methodName) {
    methodName = methodName
      .replace('__WEBPACK_DEFAULT_EXPORT__', 'default')
      .replace('__webpack_exports__.', '')
  }

  return methodName
}

interface SourceMappedFrame {
  stack: IgnorableStackFrame
  // DEV only
  code: string | null
}

/**
 * Format a method name with optional type name prefix and async/constructor modifiers.
 * V8 uses the format "[async] [new] TypeName.methodName" for method calls.
 */
function formatMethodName(
  functionName: string | undefined,
  typeName: string | undefined,
  isAsync: boolean,
  isConstructor: boolean = false
): string {
  let methodName: string
  if (functionName) {
    // Include typeName if present (e.g., "Object.then", "Promise.resolve")
    // This matches V8's native formatting
    if (typeName && typeName !== 'global') {
      methodName = typeName + '.' + functionName
    } else {
      methodName = functionName
    }
  } else {
    methodName = '<anonymous>'
  }

  // Add "new " prefix for constructor calls (before async)
  if (isConstructor && !methodName.startsWith('new ')) {
    methodName = 'new ' + methodName
  }

  // Preserve the "async" prefix for async functions
  if (isAsync && !methodName.startsWith('async ')) {
    methodName = 'async ' + methodName
  }

  return methodName
}

/**
 * Create an unsourcemapped frame from a captured frame.
 */
function createUnsourcemappedFrame(frame: CapturedFrame): SourceMappedFrame {
  const file = frame.fileName ?? null
  const methodName = formatMethodName(
    frame.functionName,
    frame.typeName,
    frame.isAsync,
    frame.isConstructor
  )
  return {
    stack: {
      file,
      line1: frame.lineNumber ?? null,
      column1: frame.columnNumber ?? null,
      methodName,
      arguments: [],
      ignored: file !== null && shouldIgnoreListGeneratedFrame(file),
    },
    code: null,
  }
}

function ignoreListAnonymousStackFramesIfSandwiched(
  sourceMappedFrames: Array<{
    stack: IgnorableStackFrame
    code: string | null
  }>
) {
  return ignoreListAnonymousStackFramesIfSandwichedGeneric(
    sourceMappedFrames,
    (frame) => frame.stack.file === '<anonymous>',
    (frame) => frame.stack.ignored,
    (frame) => frame.stack.methodName,
    (frame) => {
      frame.stack.ignored = true
    }
  )
}

/**
 * Source map a captured frame if possible.
 * @param capturedFrame - The captured frame from V8 CallSite
 * @param sourceMapCache - Cache for source map consumers
 * @param inspectOptions - Node.js inspect options
 * @returns The source mapped frame, or unsourcemapped frame if mapping fails
 */
function getSourcemappedFrameIfPossible(
  capturedFrame: CapturedFrame,
  sourceMapCache: SourceMapCache,
  inspectOptions: util.InspectOptions
): SourceMappedFrame {
  const fileName = capturedFrame.fileName
  if (fileName === undefined) {
    return createUnsourcemappedFrame(capturedFrame)
  }

  const sourceMapCacheEntry = sourceMapCache.get(fileName)
  let sourceMapConsumer: SyncSourceMapConsumer
  let sourceMapPayload: ModernSourceMapPayload
  if (sourceMapCacheEntry === undefined) {
    let sourceURL = fileName
    // e.g. "/Users/foo/APP/.next/server/chunks/ssr/[root-of-the-server]__2934a0._.js"
    // or "C:\Users\foo\APP\.next\server\chunks\ssr\[root-of-the-server]__2934a0._.js"
    // will be keyed by Node.js as "file:///APP/.next/server/chunks/ssr/[root-of-the-server]__2934a0._.js".
    // This is likely caused by `callsite.toString()` in `Error.prepareStackTrace converting file URLs to paths.
    //
    // But fileName might also be "webpack-internal:///(rsc)/./app/bad-sourcemap/page.js" or
    // "<anonymous>" or "node:internal/process/task_queues" here
    if (path.isAbsolute(fileName)) {
      sourceURL = url.pathToFileURL(fileName).toString()
    }
    let maybeSourceMapPayload: ModernSourceMapPayload | undefined
    try {
      const sourceMap = nativeFindSourceMap(sourceURL)
      maybeSourceMapPayload = sourceMap?.payload
    } catch (cause) {
      // We should not log an actual error instance here because that will re-enter
      // this codepath during error inspection and could lead to infinite recursion.
      console.error(
        `${sourceURL}: Invalid source map. Only conformant source maps can be used to find the original code. Cause: ${cause}`
      )
      // If loading fails once, it'll fail every time.
      // So set the cache to avoid duplicate errors.
      sourceMapCache.set(fileName, null)
      // Don't even fall back to the bundler because it might be not as strict
      // with regards to parsing and then we fail later once we consume the
      // source map payload.
      // This essentially avoids a redundant error where we fail here and then
      // later on consumption because the bundler just handed back an invalid
      // source map.
      return createUnsourcemappedFrame(capturedFrame)
    }
    if (maybeSourceMapPayload === undefined) {
      maybeSourceMapPayload = bundlerFindSourceMapPayload(sourceURL)
    }

    if (maybeSourceMapPayload === undefined) {
      return createUnsourcemappedFrame(capturedFrame)
    }
    sourceMapPayload = maybeSourceMapPayload
    try {
      // Pass the source map URL as the second parameter so that the consumer
      // can resolve relative paths in the source map's `sources` array.
      // This is a guess!  Turbopack places .map files as siblings to the chunks so this is sufficient to compute
      // relative paths but is actually wrong (the chunk and sourcemap have different content hashes).
      // We are using the node API to read the sourcemap and it doesn't give us access to the URI.
      const sourceMapURL = sourceURL + '.map'
      sourceMapConsumer = new SyncSourceMapConsumer(
        sourceMapPayload,
        // @ts-expect-error: our typings don't include this parameter but it is here.
        sourceMapURL
      )
    } catch (cause) {
      // We should not log an actual error instance here because that will re-enter
      // this codepath during error inspection and could lead to infinite recursion.
      console.error(
        `${sourceURL}: Invalid source map. Only conformant source maps can be used to find the original code. Cause: ${cause}`
      )
      // If creating the consumer fails once, it'll fail every time.
      // So set the cache to avoid duplicate errors.
      sourceMapCache.set(fileName, null)
      return createUnsourcemappedFrame(capturedFrame)
    }
    sourceMapCache.set(fileName, {
      map: sourceMapConsumer,
      payload: sourceMapPayload,
      nameMappings: buildNameMappings(sourceMapConsumer),
    })
  } else if (sourceMapCacheEntry === null) {
    // We failed earlier getting the payload or consumer.
    // Just return an unsourcemapped frame.
    // Errors will already be logged.
    return createUnsourcemappedFrame(capturedFrame)
  } else {
    sourceMapConsumer = sourceMapCacheEntry.map
    sourceMapPayload = sourceMapCacheEntry.payload
  }

  // Get or build the name mappings for this source map
  const cacheEntry = sourceMapCache.get(fileName)
  const nameMappings = cacheEntry?.nameMappings

  const lineNumber = capturedFrame.lineNumber ?? 1
  const columnNumber = capturedFrame.columnNumber ?? 1

  const sourcePosition = sourceMapConsumer.originalPositionFor({
    column: columnNumber - 1,
    line: lineNumber,
  })

  const applicableSourceMap = findApplicableSourceMapPayload(
    lineNumber - 1,
    columnNumber - 1,
    sourceMapPayload
  )
  let ignored =
    applicableSourceMap !== undefined &&
    sourceMapIgnoreListsEverything(applicableSourceMap)

  // Compute the full mangled name including typeName and constructor prefix for proper formatting
  const mangledName = formatMethodName(
    capturedFrame.functionName,
    capturedFrame.typeName,
    capturedFrame.isAsync,
    capturedFrame.isConstructor
  )

  if (sourcePosition.source === null) {
    return {
      stack: {
        arguments: [],
        file: fileName,
        line1: lineNumber,
        column1: columnNumber,
        methodName: mangledName,
        ignored: ignored || shouldIgnoreListGeneratedFrame(fileName),
      },
      code: null,
    }
  }

  // TODO(veil): Upstream a method to sourcemap consumer that immediately says if a frame is ignored or not.
  if (applicableSourceMap === undefined) {
    console.error(
      'No applicable source map found in sections for frame',
      capturedFrame
    )
  } else if (!ignored && shouldIgnoreListOriginalFrame(sourcePosition.source)) {
    // Externals may be libraries that don't ship ignoreLists.
    // This is really taking control away from libraries.
    // They should still ship `ignoreList` so that attached debuggers ignore-list their frames.
    // TODO: Maybe only ignore library sourcemaps if `ignoreList` is absent?
    // Though keep in mind that Turbopack omits empty `ignoreList`.
    // So if we establish this convention, we should communicate it to the ecosystem.
    ignored = true
  } else if (!ignored) {
    // TODO: O(n^2). Consider moving `ignoreList` into a Set
    const sourceIndex = applicableSourceMap.sources.indexOf(
      sourcePosition.source
    )
    ignored = applicableSourceMap.ignoreList?.includes(sourceIndex) ?? false
  }

  // The mangledName already includes async prefix and typeName from formatMethodName
  // resolveFunctionName may return a deobfuscated name that also needs these
  const methodName = resolveFunctionName(
    capturedFrame,
    nameMappings,
    mangledName
  )

  const originalFrame: IgnorableStackFrame = {
    methodName,
    file: sourcePosition.source,
    line1: sourcePosition.line,
    column1: sourcePosition.column !== null ? sourcePosition.column + 1 : null,
    arguments: [],
    ignored,
  }

  /** undefined = not yet computed*/
  let codeFrame: string | null | undefined

  return Object.defineProperty(
    {
      stack: originalFrame,
      code: null,
    },
    'code',
    {
      get: () => {
        if (codeFrame === undefined) {
          const sourceContent: string | null =
            sourceMapConsumer.sourceContentFor(
              sourcePosition.source,
              /* returnNullOnMissing */ true
            ) ?? null
          codeFrame = getOriginalCodeFrame(
            originalFrame,
            sourceContent,
            inspectOptions.colors
          )
        }
        return codeFrame
      },
    }
  )
}

function parseAndSourceMap(
  error: Error,
  inspectOptions: util.InspectOptions
): string {
  const showIgnoreListed = process.env.__NEXT_SHOW_IGNORE_LISTED === 'true'

  // Access error.stack to ensure prepareStackTrace is called and captures the stack data.
  // The stack property is lazily computed, so this triggers the capture.
  const stackString = error.stack

  // Get the captured stack trace data from the WeakMap
  const capturedStack = capturedStackTraces.get(error)
  const errorName = capturedStack?.name ?? computeErrorName(error)

  // Get frames from captured data, or fall back to parsing the stack string.
  // The WeakMap lookup can fail when error objects are cloned/serialized
  // across process boundaries (e.g., during prerendering).
  let frames: CapturedFrame[]
  if (capturedStack && capturedStack.frames.length > 0) {
    frames = capturedStack.frames
  } else if (stackString) {
    // Parse the stack string to extract frames for filtering.
    // Wrap in try-catch to avoid infinite recursion if parsing fails.
    let parsedFrames: StackFrame[]
    try {
      parsedFrames = parseStack(stackString)
    } catch {
      // If parsing fails, return the original stack string as-is
      return stackString
    }
    frames = parsedFrames.map((frame) => {
      // Check if the method name starts with "async " or "new " to detect async/constructor calls
      let methodName = frame.methodName ?? ''
      const isAsync = methodName.startsWith('async ')
      if (isAsync) {
        methodName = methodName.slice(6) // Remove "async " prefix
      }
      const isConstructor = methodName.startsWith('new ')
      if (isConstructor) {
        methodName = methodName.slice(4) // Remove "new " prefix
      }
      return {
        functionName: methodName || undefined,
        typeName: undefined,
        fileName: frame.file ?? undefined,
        lineNumber: frame.line1 ?? undefined,
        columnNumber: frame.column1 ?? undefined,
        enclosingLineNumber: undefined,
        enclosingColumnNumber: undefined,
        isAsync,
        isConstructor,
      }
    })
  } else {
    return `${errorName}: ${error.message}`
  }
  if (!showIgnoreListed) {
    const reactBottomIdx = frames.findIndex(
      (f) =>
        f.functionName?.includes('react_stack_bottom_frame') ||
        f.functionName?.includes('react-stack-bottom-frame')
    )
    if (reactBottomIdx !== -1) {
      frames = frames.slice(0, reactBottomIdx)
    }
  }

  const sourceMapCache: SourceMapCache = new Map()

  const sourceMappedFrames: Array<{
    stack: IgnorableStackFrame
    code: string | null
  }> = []
  let sourceFrame: null | string = null
  for (const frame of frames) {
    const sourcemappedFrame = getSourcemappedFrameIfPossible(
      frame,
      sourceMapCache,
      inspectOptions
    )
    sourceMappedFrames.push(sourcemappedFrame)

    // We can determine the sourceframe here.
    // anonymous frames won't have a sourceframe so we don't need to scan
    // all stacks again to check if they are sandwiched between ignored frames.
    if (
      sourceFrame === null &&
      // TODO: Is this the right choice?
      !sourcemappedFrame.stack.ignored &&
      sourcemappedFrame.code !== null
    ) {
      sourceFrame = sourcemappedFrame.code
    }
  }

  ignoreListAnonymousStackFramesIfSandwiched(sourceMappedFrames)

  let sourceMappedStack = ''
  for (let i = 0; i < sourceMappedFrames.length; i++) {
    const frame = sourceMappedFrames[i]

    if (!frame.stack.ignored) {
      sourceMappedStack +=
        '\n' +
        frameToString(
          frame.stack.methodName,
          frame.stack.file,
          frame.stack.line1,
          frame.stack.column1
        )
    } else if (showIgnoreListed) {
      sourceMappedStack +=
        '\n' +
        dim(
          frameToString(
            frame.stack.methodName,
            frame.stack.file,
            frame.stack.line1,
            frame.stack.column1
          )
        )
    }
  }

  if (sourceMappedStack === '' && sourceMappedFrames.length > 0) {
    // The `at` marker is important so that Node.js doesn't add square brackets
    // around the stringified error i.e. this results in
    // Error: message
    //   at <ignore-listed frames>
    // instead of
    // [Error: message
    //   at <ignore-listed frames>]
    sourceMappedStack = '\n    at ' + italic('ignore-listed frames')
  }

  return (
    errorName +
    ': ' +
    error.message +
    sourceMappedStack +
    (sourceFrame !== null ? '\n' + sourceFrame : '')
  )
}

function sourceMapError(
  this: void,
  error: Error,
  inspectOptions: util.InspectOptions
): Error {
  // Create a new Error object with the source mapping applied and then use native
  // Node.js formatting on the result.
  const newError =
    error.cause !== undefined
      ? // Setting an undefined `cause` would print `[cause]: undefined`
        new Error(error.message, { cause: error.cause })
      : new Error(error.message)

  // TODO: Ensure `class MyError extends Error {}` prints `MyError` as the name
  newError.stack = parseAndSourceMap(error, inspectOptions)

  for (const key in error) {
    if (!Object.prototype.hasOwnProperty.call(newError, key)) {
      // @ts-expect-error -- We're copying all enumerable properties.
      // So they definitely exist on `this` and obviously have no type on `newError` (yet)
      newError[key] = error[key]
    }
  }

  return newError
}

export function patchErrorInspectNodeJS(
  errorConstructor: ErrorConstructor
): void {
  const inspectSymbol = Symbol.for('nodejs.util.inspect.custom')

  errorConstructor.prepareStackTrace = prepareUnsourcemappedStackTrace

  // @ts-expect-error -- TODO upstream types
  errorConstructor.prototype[inspectSymbol] = function (
    depth: number,
    inspectOptions: util.InspectOptions,
    inspect: typeof util.inspect
  ): string {
    // avoid false-positive dynamic i/o warnings e.g. due to usage of `Math.random` in `source-map`.
    return workUnitAsyncStorage.exit(() => {
      const newError = sourceMapError(this, inspectOptions)

      const originalCustomInspect = (newError as any)[inspectSymbol]
      // Prevent infinite recursion.
      // { customInspect: false } would result in `error.cause` not using our inspect.
      Object.defineProperty(newError, inspectSymbol, {
        value: undefined,
        enumerable: false,
        writable: true,
      })
      try {
        return inspect(newError, {
          ...inspectOptions,
          depth:
            (inspectOptions.depth ??
              // Default in Node.js
              2) - depth,
        })
      } finally {
        ;(newError as any)[inspectSymbol] = originalCustomInspect
      }
    })
  }
}

export function patchErrorInspectEdgeLite(
  errorConstructor: ErrorConstructor
): void {
  const inspectSymbol = Symbol.for('edge-runtime.inspect.custom')

  errorConstructor.prepareStackTrace = prepareUnsourcemappedStackTrace

  // @ts-expect-error -- TODO upstream types
  errorConstructor.prototype[inspectSymbol] = function ({
    format,
  }: {
    format: (...args: unknown[]) => string
  }): string {
    // avoid false-positive dynamic i/o warnings e.g. due to usage of `Math.random` in `source-map`.
    return workUnitAsyncStorage.exit(() => {
      const newError = sourceMapError(this, {})

      const originalCustomInspect = (newError as any)[inspectSymbol]
      // Prevent infinite recursion.
      Object.defineProperty(newError, inspectSymbol, {
        value: undefined,
        enumerable: false,
        writable: true,
      })
      try {
        return format(newError)
      } finally {
        ;(newError as any)[inspectSymbol] = originalCustomInspect
      }
    })
  }
}
