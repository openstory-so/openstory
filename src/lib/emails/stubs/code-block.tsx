/**
 * Build-time stand-in for `@react-email/code-block`, wired in via a Vite
 * `resolve.alias` (see vite.config.ts).
 *
 * The real package imports prismjs and registers every language grammar at
 * module scope — ~380 ms of CPU during Worker isolate startup, which put the
 * deployed bundle over Cloudflare's startup validation limit (error 10021)
 * and made preview deploys flap. It reaches the worker even though no email
 * uses <CodeBlock>: `@react-email/tailwind` imports the component solely for
 * an `element.type` identity check in its style-inlining walk, so a stub that
 * never matches is behaviorally identical.
 *
 * If an email ever needs real syntax-highlighted code blocks, remove the
 * alias and pay the startup cost deliberately (or lazy-load the renderer).
 */
export const CodeBlock = () => null;
