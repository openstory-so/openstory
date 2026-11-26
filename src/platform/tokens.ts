/** About four characters a token: the estimate for text no provider has counted. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
