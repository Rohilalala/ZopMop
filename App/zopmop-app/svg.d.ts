// Ambient module declaration for *.svg imports.
//
// RN/Metro resolves these at runtime via react-native-svg-transformer
// (configured in metro.config.js). TypeScript needs this declaration so
// `import Foo from './foo.svg'` compiles without "Cannot find module"
// errors at every call site.
//
// Pure compile-time shape — no runtime impact.

declare module '*.svg' {
	import type React from 'react';
	import type { SvgProps } from 'react-native-svg';
	const content: React.FC<SvgProps>;
	export default content;
}
