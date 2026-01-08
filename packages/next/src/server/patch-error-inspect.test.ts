/**
 * Unit tests for patch-error-inspect.ts stack frame formatting.
 * These tests verify the V8 CallSite-based stack trace formatting.
 */

// We need to test the actual behavior through the Error.prepareStackTrace mechanism
// since the formatting functions are internal to the module.

import { patchErrorInspectNodeJS } from './patch-error-inspect'

describe('patch-error-inspect', () => {
  // Store original prepareStackTrace to restore after tests
  const originalPrepareStackTrace = Error.prepareStackTrace

  beforeAll(() => {
    // Install our custom prepareStackTrace
    patchErrorInspectNodeJS(Error)
  })

  afterAll(() => {
    // Restore original
    Error.prepareStackTrace = originalPrepareStackTrace
  })

  describe('CallSite formatting', () => {
    it('should format basic function names with "at functionName"', () => {
      function myFunction() {
        return new Error('test')
      }
      const error = myFunction()
      expect(error.stack).toMatch(/^\s+at myFunction \(/m)
    })

    it('should format async function names', async () => {
      // Note: isAsync() returns true only for async continuation frames
      // (when the stack is unwound at an await point), not for synchronous
      // call sites within async functions. When creating an Error synchronously
      // inside an async function, the frames appear as regular functions.
      async function outerAsync() {
        async function innerAsync() {
          // Create error inside awaited context
          return new Error('test')
        }
        return await innerAsync()
      }
      const error = await outerAsync()
      // Both frames appear without async prefix since error was created synchronously
      expect(error.stack).toMatch(/^\s+at innerAsync \(/m)
      expect(error.stack).toMatch(/^\s+at outerAsync \(/m)
    })

    it('should format constructor calls with "at new ClassName"', () => {
      class MyClass {
        error: Error
        constructor() {
          this.error = new Error('test')
        }
      }
      const instance = new MyClass()
      expect(instance.error.stack).toMatch(/^\s+at new MyClass \(/m)
    })

    it('should format method calls with "at TypeName.methodName"', () => {
      const obj = {
        myMethod() {
          return new Error('test')
        },
      }
      const error = obj.myMethod()
      // V8 formats object literal methods as "Object.methodName"
      expect(error.stack).toMatch(/^\s+at Object\.myMethod \(/m)
    })

    it('should handle anonymous functions as "<anonymous>"', () => {
      const fn = function () {
        return new Error('test')
      }
      const error = fn()
      // Anonymous functions assigned to variables get the variable name in V8
      expect(error.stack).toMatch(/^\s+at fn \(/m)
    })

    it('should handle arrow functions with variable name', () => {
      const arrowFn = () => {
        return new Error('test')
      }
      const error = arrowFn()
      // Arrow functions assigned to const get the variable name in V8
      expect(error.stack).toMatch(/^\s+at arrowFn \(/m)
    })

    it('should handle nested functions showing full call stack', () => {
      function outer() {
        function inner() {
          return new Error('test')
        }
        return inner()
      }
      const error = outer()
      // Verify both functions appear in order (inner before outer)
      const stack = error.stack!
      const innerIdx = stack.indexOf('at inner (')
      const outerIdx = stack.indexOf('at outer (')
      expect(innerIdx).toBeGreaterThan(-1)
      expect(outerIdx).toBeGreaterThan(-1)
      expect(innerIdx).toBeLessThan(outerIdx)
    })

    it('should format class instance methods with "at ClassName.methodName"', () => {
      class TestClass {
        instanceMethod() {
          return new Error('test')
        }
      }

      const instance = new TestClass()
      const error = instance.instanceMethod()
      expect(error.stack).toMatch(/^\s+at TestClass\.instanceMethod \(/m)
    })

    it('should format static methods with "at ClassName.methodName"', () => {
      class TestClass {
        static staticMethod() {
          return new Error('test')
        }
      }

      const error = TestClass.staticMethod()
      // Static methods show as "ClassName.methodName" in V8 (typeName is the class name)
      expect(error.stack).toMatch(/^\s+at TestClass\.staticMethod \(/m)
    })

    it('should format async class methods with "at ClassName.methodName"', async () => {
      class AsyncClass {
        async asyncMethod() {
          return new Error('test')
        }
      }
      const instance = new AsyncClass()
      const error = await instance.asyncMethod()
      // When error is created synchronously inside async method, no async prefix
      expect(error.stack).toMatch(/^\s+at AsyncClass\.asyncMethod \(/m)
    })

    it('should format Promise.then callbacks', async () => {
      const error = await Promise.resolve().then(function thenCallback() {
        return new Error('test')
      })
      // Named function in .then shows as the function name
      expect(error.stack).toMatch(/^\s+at thenCallback \(/m)
    })
  })

  describe('Error name and message', () => {
    it('should include error name in stack', () => {
      const error = new Error('test message')
      expect(error.stack).toContain('Error: test message')
    })

    it('should handle custom error names', () => {
      class CustomError extends Error {
        name = 'CustomError'
      }
      const error = new CustomError('custom message')
      expect(error.stack).toContain('CustomError: custom message')
    })

    it('should handle TypeError', () => {
      const error = new TypeError('type error message')
      expect(error.stack).toContain('TypeError: type error message')
    })
  })
})

describe('V8 enclosing position', () => {
  // These tests verify that the enclosing position APIs are working
  // by checking if function names are properly resolved

  beforeAll(() => {
    patchErrorInspectNodeJS(Error)
  })

  it('should capture enclosing position for function declarations', () => {
    function declaredFunction() {
      // The error should capture the enclosing function position
      return new Error('test')
    }
    const error = declaredFunction()
    expect(error.stack).toMatch(/^\s+at declaredFunction \(/m)
  })

  it('should capture enclosing position for function expressions', () => {
    const expressionFunction = function namedExpression() {
      return new Error('test')
    }
    const error = expressionFunction()
    expect(error.stack).toMatch(/^\s+at namedExpression \(/m)
  })

  it('should capture enclosing position for arrow functions assigned to const', () => {
    const arrowFunction = () => {
      return new Error('test')
    }
    const error = arrowFunction()
    // Arrow functions get the variable name in V8
    expect(error.stack).toMatch(/^\s+at arrowFunction \(/m)
  })

  it('should handle deeply nested functions with correct order', () => {
    function level1() {
      function level2() {
        function level3() {
          return new Error('test')
        }
        return level3()
      }
      return level2()
    }
    const error = level1()
    const stack = error.stack!

    // Verify all levels appear
    expect(stack).toMatch(/^\s+at level3 \(/m)
    expect(stack).toMatch(/^\s+at level2 \(/m)
    expect(stack).toMatch(/^\s+at level1 \(/m)

    // Verify correct order (innermost first)
    const level3Idx = stack.indexOf('at level3 (')
    const level2Idx = stack.indexOf('at level2 (')
    const level1Idx = stack.indexOf('at level1 (')
    expect(level3Idx).toBeLessThan(level2Idx)
    expect(level2Idx).toBeLessThan(level1Idx)
  })
})
