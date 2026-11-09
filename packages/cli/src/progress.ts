// A minimal progress bar on stderr (parsedmarc uses tqdm when stderr is a
// terminal).

const BAR_WIDTH = 30;

export class ProgressBar {
  readonly total: number;
  private count = 0;
  private readonly stream: NodeJS.WriteStream;

  constructor(total: number, stream: NodeJS.WriteStream = process.stderr) {
    this.total = total;
    this.stream = stream;
    this.render();
  }

  update(amount = 1): void {
    this.count += amount;
    this.render();
  }

  close(): void {
    this.stream.write('\n');
  }

  private render(): void {
    const ratio = this.total === 0 ? 1 : Math.min(this.count / this.total, 1);
    const filled = Math.round(ratio * BAR_WIDTH);
    const percent = String(Math.round(ratio * 100)).padStart(3);
    this.stream.write(
      `\r${percent}%|${'█'.repeat(filled)}${' '.repeat(BAR_WIDTH - filled)}| ${this.count}/${this.total}`,
    );
  }
}
