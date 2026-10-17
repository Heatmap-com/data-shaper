/** Ring buffer of the last N lines. */
export function createTail(max) {
  const lines = [];
  return {
    push(line) {
      lines.push(line);
      if (lines.length > max) lines.splice(0, lines.length - max);
    },
    text: () => lines.join('\n'),
  };
}
