import type { SourceMapConsumer } from 'next/dist/compiled/source-map'

/**
 * Represents a function scope in generated code with its boundaries and names.
 *
 * The start/end line/column pairs define the full extent of the function body,
 * from the function keyword through its closing brace.
 */
export interface FunctionScope {
  /** Original function name from source map */
  name: string
  /** Mangled/generated function name in the generated code (for validation) */
  mangledName: string | undefined
  /** Starting line of function in generated code (1-indexed) */
  startLine: number
  /** Starting column of function in generated code (0-indexed) */
  startColumn: number
  /** Ending line of function in generated code (1-indexed) */
  endLine: number
  /** Ending column of function in generated code (0-indexed) */
  endColumn: number
}

/**
 * Helper to extract position from a Babel AST location object.
 */
function getPosition(loc: any): { line: number; column: number } {
  return {
    line: loc.start.line,
    column: loc.start.column,
  }
}

/**
 * Parse generated source code and extract function scopes with their names
 * resolved via source map.
 *
 * This uses Babel parser to accurately identify function boundaries in the
 * generated code, then correlates them with source map name mappings.
 *
 * @param generatedSource - The generated/minified source code
 * @param sourceMapConsumer - The source map consumer
 * @returns Array of function scopes sorted by start position
 */
export function parseFunctionScopes(
  generatedSource: string,
  sourceMapConsumer: SourceMapConsumer
): FunctionScope[] {
  const scopes: FunctionScope[] = []

  // Build a map of position -> name from source map
  const namesByPosition = new Map<string, string>()
  sourceMapConsumer.eachMapping((mapping) => {
    if (!mapping.name) return
    const key = `${mapping.generatedLine}:${mapping.generatedColumn}`
    namesByPosition.set(key, mapping.name)
  })

  if (namesByPosition.size === 0) {
    // No named mappings, nothing to do
    return []
  }

  try {
    // Use Babel parser to extract function boundaries
    const { parse } =
      require('next/dist/compiled/babel/parser') as typeof import('next/dist/compiled/babel/parser')
    const traverse = (
      require('next/dist/compiled/babel/traverse') as typeof import('next/dist/compiled/babel/traverse')
    ).default

    const ast = parse(generatedSource, {
      sourceType: 'unambiguous',
      errorRecovery: true,
    })

    traverse(ast, {
      // Match all function-like nodes
      'FunctionDeclaration|FunctionExpression|ArrowFunctionExpression|ObjectMethod|ClassMethod'(
        path: any
      ) {
        const node = path.node
        if (!node.loc) return

        // Try to find the function name in various places
        let mangledName: string | undefined = undefined
        let namePosition: { line: number; column: number } | undefined =
          undefined

        if (node.type === 'FunctionDeclaration' && node.id) {
          // function foo() {}
          mangledName = node.id.name
          namePosition = getPosition(node.id.loc)
        } else if (node.type === 'FunctionExpression') {
          // function expression: function foo() {} or function() {}
          if (node.id && node.id.loc) {
            // Named function expression
            mangledName = node.id.name
            namePosition = getPosition(node.id.loc)
          } else {
            // Anonymous function expression - check parent
            const parent = path.parent
            if (
              parent.type === 'VariableDeclarator' &&
              parent.id.type === 'Identifier'
            ) {
              // const x = function() {}
              mangledName = parent.id.name
              namePosition = getPosition(parent.id.loc)
            } else if (
              (parent.type === 'Property' ||
                parent.type === 'ObjectProperty') &&
              parent.key.type === 'Identifier'
            ) {
              // { handler: function() {} }
              mangledName = parent.key.name
              namePosition = getPosition(parent.key.loc)
            }
          }
        } else if (
          (node.type === 'ObjectMethod' || node.type === 'ClassMethod') &&
          node.key.type === 'Identifier'
        ) {
          // { foo() {} } or class { foo() {} }
          mangledName = node.key.name
          namePosition = getPosition(node.key.loc)
        } else if (node.type === 'ArrowFunctionExpression') {
          // const foo = () => {}
          // Look at parent to find the variable name
          const parent = path.parent
          if (
            parent.type === 'VariableDeclarator' &&
            parent.id.type === 'Identifier'
          ) {
            mangledName = parent.id.name
            namePosition = getPosition(parent.id.loc)
          }
        }

        // Check if we have a source map name at this position
        if (namePosition) {
          const key = `${namePosition.line}:${namePosition.column}`
          const originalName = namesByPosition.get(key)

          if (originalName) {
            // Found a match! Create the scope
            // For arrow functions and anonymous function expressions, we need to extend
            // the scope to include the variable/property declaration, because when
            // generatedPositionFor() is called with an unmapped position, it returns
            // the nearest mapped position (the variable name), which may be before
            // the function body starts.
            let scopeStart = node.loc.start
            const scopeEnd = node.loc.end

            if (path.parent.type === 'VariableDeclarator' && path.parent.loc) {
              // const foo = () => {} or const foo = function() {}
              scopeStart = path.parent.loc.start
            } else if (
              (path.parent.type === 'Property' ||
                path.parent.type === 'ObjectProperty') &&
              path.parent.loc
            ) {
              // { handler: function() {} }
              scopeStart = path.parent.loc.start
            }

            scopes.push({
              name: originalName,
              mangledName,
              startLine: scopeStart.line,
              startColumn: scopeStart.column,
              endLine: scopeEnd.line,
              endColumn: scopeEnd.column,
            })
          }
        }
      },
    })
  } catch (error) {
    // If parsing fails, return empty array
    // This can happen with malformed or extremely minified code
    return []
  }

  // Sort by start position (line, then column) for binary search
  scopes.sort((a, b) => {
    if (a.startLine !== b.startLine) {
      return a.startLine - b.startLine
    }
    return a.startColumn - b.startColumn
  })

  return scopes
}

/**
 * Find the innermost function scope containing the given position.
 * Uses binary search for O(log n) lookup.
 *
 * @param scopes - Array of function scopes sorted by start position
 * @param line - Line number in generated code (1-indexed)
 * @param column - Column number in generated code (0-indexed)
 * @param mangledName - Optional mangled name from stack trace for validation
 * @returns The function name, or undefined if not found
 */
function findEnclosingFunctionScope(
  scopes: FunctionScope[],
  line: number,
  column: number,
  mangledName: string | undefined
): string | undefined {
  if (scopes.length === 0) return undefined

  // Find all scopes that contain this position
  // A scope contains the position if:
  //   (startLine < line || (startLine === line && startColumn <= column))
  //   AND
  //   (endLine > line || (endLine === line && endColumn > column))

  let bestScope: FunctionScope | null = null

  // Binary search to find the first scope that could contain this position
  let left = 0
  let right = scopes.length - 1

  while (left <= right) {
    const mid = Math.floor((left + right) / 2)
    const scope = scopes[mid]

    // Check if this scope's start is before or at the target position
    const startsBefore =
      scope.startLine < line ||
      (scope.startLine === line && scope.startColumn <= column)

    if (startsBefore) {
      // This scope starts before/at the target, check if it contains it
      const endsAfter =
        scope.endLine > line ||
        (scope.endLine === line && scope.endColumn > column)

      if (endsAfter) {
        // This scope contains the target position
        // Keep it if it's more specific (starts later) than our current best
        if (
          !bestScope ||
          scope.startLine > bestScope.startLine ||
          (scope.startLine === bestScope.startLine &&
            scope.startColumn > bestScope.startColumn)
        ) {
          bestScope = scope
        }
      }

      // Continue searching to the right for potentially better matches
      left = mid + 1
    } else {
      // This scope starts after the target, search left
      right = mid - 1
    }
  }

  // If we found a scope and have a mangled name, validate the match
  if (bestScope && mangledName && bestScope.mangledName !== undefined) {
    // The mangled name should match. If it doesn't, this might be a false match
    // due to overlapping scopes or minification complexities.
    if (bestScope.mangledName !== mangledName) {
      return undefined
    }
  }

  return bestScope?.name ?? undefined
}

/**
 * Find the enclosing function name using source maps and parsed function scopes.
 *
 * Algorithm:
 * 1. Map the error position from original source to generated source
 * 2. Use the pre-parsed function scopes to find the innermost function
 *    containing that position via binary search
 * 3. Optionally validate the match using the mangled name from the stack trace
 *
 * @param sourceMapConsumer - The source map consumer
 * @param originalSource - The source file name in the source map
 * @param originalLine - The error line number in original source (1-indexed)
 * @param originalColumn - The error column number in original source (0-indexed)
 * @param mangledName - Optional mangled function name from the stack trace for validation
 * @param functionScopes - Pre-parsed function scopes from the generated code
 * @returns The function name, or undefined if not found
 */
export function findSourceMapFunctionName(
  sourceMapConsumer: SourceMapConsumer,
  originalSource: string,
  originalLine: number,
  originalColumn: number,
  mangledName: string | undefined,
  functionScopes: FunctionScope[]
): string | undefined {
  // Map the error position to generated code
  const generatedPosition = sourceMapConsumer.generatedPositionFor({
    source: originalSource,
    line: originalLine,
    column: originalColumn,
  })

  if (!generatedPosition.line || !generatedPosition.column) {
    // Can't map to generated position
    return undefined
  }

  return findEnclosingFunctionScope(
    functionScopes,
    generatedPosition.line,
    generatedPosition.column,
    mangledName
  )
}
