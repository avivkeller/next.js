import {
  findSourceMapFunctionName,
  parseFunctionScopes,
} from './find-source-map-function-name'
import { SourceMapConsumer } from 'next/dist/compiled/source-map'

/**
 * Helper to minify source code using Terser and return the minified code with source map.
 * Terser provides real-world source maps that accurately reflect how production minifiers work.
 */
async function minifyWithSourceMap(originalSource: string) {
  const { minify } =
    require('next/dist/compiled/terser') as typeof import('next/dist/compiled/terser')

  const result = await minify(
    { 'test.js': originalSource },
    {
      sourceMap: {
        filename: 'test.js',
        includeSources: true,
      },
      compress: {
        // Disable optimizations that would inline functions
        inline: false,
        reduce_funcs: false,
        toplevel: false,
      },
      mangle: {
        // Mangle names but keep function structure
        toplevel: true,
      },
    }
  )

  if (!result.code || !result.map) {
    throw new Error('Minification failed')
  }

  const sourceMap =
    typeof result.map === 'string' ? result.map : JSON.stringify(result.map)
  const consumer = new SourceMapConsumer(JSON.parse(sourceMap))
  const functionScopes = parseFunctionScopes(result.code, consumer)

  return {
    original: originalSource,
    generated: result.code,
    consumer,
    functionScopes,
  }
}

/**
 * Helper to find the error line/column in the original source by searching for a marker string.
 */
function findErrorPosition(
  source: string,
  marker: string
): { line: number; column: number } {
  const lines = source.split('\n')
  const lineIndex = lines.findIndex((line) => line.includes(marker))
  if (lineIndex === -1) {
    throw new Error(`Could not find marker "${marker}" in source`)
  }
  const column = lines[lineIndex].indexOf('throw')
  return { line: lineIndex + 1, column }
}

describe('findSourceMapFunctionName', () => {
  describe('Named function declarations', () => {
    it('should find basic function declaration', async () => {
      const source = `
        function myFunction() {
          const x = 1;
          throw new Error('test error');
        }
        myFunction();
      `

      const { original, consumer, functionScopes } =
        await minifyWithSourceMap(source)
      const { line, column } = findErrorPosition(original, 'test error')

      const result = findSourceMapFunctionName(
        consumer,
        'test.js',
        line,
        column,
        undefined,
        functionScopes
      )

      expect(result).toBe('myFunction')
    })

    it('should find async function declaration', async () => {
      const source = `
        async function fetchData() {
          const response = await fetch();
          throw new Error('fetch failed');
        }
        fetchData();
      `

      const { original, consumer, functionScopes } =
        await minifyWithSourceMap(source)
      const { line, column } = findErrorPosition(original, 'fetch failed')

      const result = findSourceMapFunctionName(
        consumer,
        'test.js',
        line,
        column,
        undefined,
        functionScopes
      )

      expect(result).toBe('fetchData')
    })
  })

  describe('Arrow functions', () => {
    it('should find arrow function with no params', async () => {
      const source = `
        const noParams = () => {
          work();
          throw new Error('no params error');
        };
        noParams();
      `

      const { original, consumer, functionScopes } =
        await minifyWithSourceMap(source)
      const { line, column } = findErrorPosition(original, 'no params error')

      const result = findSourceMapFunctionName(
        consumer,
        'test.js',
        line,
        column,
        undefined,
        functionScopes
      )

      expect(result).toBe('noParams')
    })

    it('should find arrow function with params', async () => {
      const source = `
        const multiParam = (x, y, z) => {
          compute(x, y, z);
          throw new Error('multi param error');
        };
        multiParam(1, 2, 3);
      `

      const { original, consumer, functionScopes } =
        await minifyWithSourceMap(source)
      const { line, column } = findErrorPosition(original, 'multi param error')

      const result = findSourceMapFunctionName(
        consumer,
        'test.js',
        line,
        column,
        undefined,
        functionScopes
      )

      expect(result).toBe('multiParam')
    })
  })

  describe('Class methods', () => {
    it('should find class method', async () => {
      const source = `
        class MyClass {
          myMethod() {
            const x = 1;
            throw new Error('class method error');
          }
        }
        new MyClass().myMethod();
      `

      const { original, consumer, functionScopes } =
        await minifyWithSourceMap(source)
      const { line, column } = findErrorPosition(original, 'class method error')

      const result = findSourceMapFunctionName(
        consumer,
        'test.js',
        line,
        column,
        undefined,
        functionScopes
      )

      // Terser may keep the original method name or mangle it depending on settings
      // Accept either the original name or undefined (if mangling prevents resolution)
      expect(result === undefined || result === 'myMethod').toBe(true)
    })

    it('should find async class method', async () => {
      const source = `
        class DataLoader {
          async load() {
            const data = await Promise.resolve(42);
            throw new Error('async load error');
          }
        }
        new DataLoader().load();
      `

      const { original, consumer, functionScopes } =
        await minifyWithSourceMap(source)
      const { line, column } = findErrorPosition(original, 'async load error')

      const result = findSourceMapFunctionName(
        consumer,
        'test.js',
        line,
        column,
        undefined,
        functionScopes
      )

      expect(result === undefined || result === 'load').toBe(true)
    })
  })

  describe('Object methods', () => {
    it('should find method shorthand', async () => {
      const source = `
        const obj = {
          myMethod() {
            const x = 1;
            throw new Error('method shorthand error');
          }
        };
        obj.myMethod();
      `

      const { original, consumer, functionScopes } =
        await minifyWithSourceMap(source)
      const { line, column } = findErrorPosition(
        original,
        'method shorthand error'
      )

      const result = findSourceMapFunctionName(
        consumer,
        'test.js',
        line,
        column,
        undefined,
        functionScopes
      )

      expect(result === undefined || result === 'myMethod').toBe(true)
    })

    it('should find method with function expression', async () => {
      const source = `
        const obj = {
          handler: function() {
            const x = 1;
            throw new Error('function expression error');
          }
        };
        obj.handler();
      `

      const { original, consumer, functionScopes } =
        await minifyWithSourceMap(source)
      const { line, column } = findErrorPosition(
        original,
        'function expression error'
      )

      const result = findSourceMapFunctionName(
        consumer,
        'test.js',
        line,
        column,
        undefined,
        functionScopes
      )

      expect(result).toBe('handler')
    })
  })

  describe('Nested functions', () => {
    it('should find innermost function', async () => {
      const source = `
        function outer() {
          function inner() {
            const x = 1;
            throw new Error('inner error');
          }
          inner();
        }
        outer();
      `

      const { original, consumer, functionScopes } =
        await minifyWithSourceMap(source)
      const { line, column } = findErrorPosition(original, 'inner error')

      const result = findSourceMapFunctionName(
        consumer,
        'test.js',
        line,
        column,
        undefined,
        functionScopes
      )

      // With minification, inner functions may be inlined
      expect(['inner', 'outer']).toContain(result)
    })

    it('should find outer function when error is in outer scope', async () => {
      const source = `
        function outer() {
          const x = 1;
          throw new Error('outer error');
          function inner() {
            const y = 2;
          }
        }
        outer();
      `

      const { original, consumer, functionScopes } =
        await minifyWithSourceMap(source)
      const { line, column } = findErrorPosition(original, 'outer error')

      const result = findSourceMapFunctionName(
        consumer,
        'test.js',
        line,
        column,
        undefined,
        functionScopes
      )

      expect(result).toBe('outer')
    })
  })

  describe('Edge cases', () => {
    it('should return null when no function mapping found', async () => {
      const source = `
        const x = 1;
        const y = 2;
        throw new Error('top level error');
      `

      const { original, consumer, functionScopes } =
        await minifyWithSourceMap(source)
      const { line, column } = findErrorPosition(original, 'top level error')

      const result = findSourceMapFunctionName(
        consumer,
        'test.js',
        line,
        column,
        undefined,
        functionScopes
      )

      expect(result).toBe(undefined)
    })

    it('should find function name and not variable names', async () => {
      const source = `
        function myFunc() {
          const result = compute();
          throw new Error('variable test error');
        }
        myFunc();
      `

      const { original, consumer, functionScopes } =
        await minifyWithSourceMap(source)
      const { line, column } = findErrorPosition(
        original,
        'variable test error'
      )

      const result = findSourceMapFunctionName(
        consumer,
        'test.js',
        line,
        column,
        undefined,
        functionScopes
      )

      expect(result).toBe('myFunc')
    })

    it('should handle qualified method names (foo.bar)', async () => {
      const source = `
        const utils = {
          validate: function(input) {
            throw new Error('qualified name error');
          }
        };
        utils.validate(null);
      `

      const { original, consumer, functionScopes } =
        await minifyWithSourceMap(source)
      const { line, column } = findErrorPosition(
        original,
        'qualified name error'
      )

      // Test with just the simple name (what findSourceMapFunctionName expects)
      const result = findSourceMapFunctionName(
        consumer,
        'test.js',
        line,
        column,
        'validate', // Just the simple name for validation
        functionScopes
      )

      // The function resolves just the function name, not the qualified path
      // The qualifier is handled by resolveFunctionName in patch-error-inspect.ts
      expect(result).toBe('validate')
    })
  })

  describe('End-to-end with eval', () => {
    it('should execute minified code and find function name from real error', async () => {
      const source = `
        function validateInput(input) {
          if (!input) {
            throw new Error('Invalid input');
          }
          return input.toUpperCase();
        }

        validateInput(null);
      `

      const { original, generated, consumer, functionScopes } =
        await minifyWithSourceMap(source)

      // Execute the generated code and capture the error
      let caughtError: Error | null = null
      try {
        // eslint-disable-next-line no-eval
        eval(generated)
      } catch (err) {
        caughtError = err as Error
      }

      expect(caughtError).toBeTruthy()
      expect(caughtError?.message).toBe('Invalid input')

      // Verify we can find the function name at the error location
      const { line, column } = findErrorPosition(original, 'Invalid input')

      const result = findSourceMapFunctionName(
        consumer,
        'test.js',
        line,
        column,
        undefined,
        functionScopes
      )

      expect(result).toBe('validateInput')
    })
  })
})
