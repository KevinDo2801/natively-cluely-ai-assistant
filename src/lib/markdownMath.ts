import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import type { Options as ReactMarkdownOptions } from 'react-markdown';
// KaTeX's stylesheet carries the math fonts (@font-face). Without it the
// formula markup renders as unstyled/garbled glyphs, so it travels with the
// plugins: any surface that imports these gets correct fonts too.
import 'katex/dist/katex.min.css';

/**
 * Shared markdown plugin set for surfaces that render model output: GitHub-style
 * markdown plus LaTeX (`$x$`, `$$x$$`). Hoisted constants — ReactMarkdown
 * re-processes when the plugin array identity changes, so inline literals would
 * re-parse the whole document on every render.
 *
 * `throwOnError: false` keeps a malformed formula from taking down the message:
 * KaTeX renders the offending source in red instead of throwing.
 */
export const MATH_REMARK_PLUGINS: NonNullable<ReactMarkdownOptions['remarkPlugins']> = [remarkGfm, remarkMath];

export const MATH_REHYPE_PLUGINS: NonNullable<ReactMarkdownOptions['rehypePlugins']> = [
  [rehypeKatex, { throwOnError: false, strict: false, errorColor: '#cc0000' }],
];
