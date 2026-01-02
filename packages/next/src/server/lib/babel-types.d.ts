// Minimal type declarations for compiled Babel modules
// These modules are bundled into Next.js at next/dist/compiled/babel/*
// The original @babel packages are only in devDependencies, so we use minimal any types here

declare module 'next/dist/compiled/babel/parser' {
  export function parse(code: string, options?: any): any
}
