// Chunks joined per block: Expat reports every newline and entity as its own
// chunk, and the recovering parser every run of an attribute value, so a text
// of a million newlines would otherwise be held as a million strings until
// its end.
const TEXT_BLOCK_CHUNKS = 1024;

/** A text made of many small pieces, in the order they are pushed. */
export class TextBuffer {
  private readonly blocks: string[] = [];
  private chunks: string[] = [];

  push(chunk: string): void {
    this.chunks.push(chunk);
    if (this.chunks.length >= TEXT_BLOCK_CHUNKS) {
      this.blocks.push(this.chunks.join(''));
      this.chunks = [];
    }
  }

  /** The joined text, or null when nothing was pushed. */
  text(): string | null {
    if (this.blocks.length === 0) {
      return this.chunks.length === 0 ? null : this.chunks.join('');
    }
    return this.blocks.join('') + this.chunks.join('');
  }
}
