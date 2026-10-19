/** Keep the best K items with O(log K) insertion memory and deterministic ordering. */
export class BoundedBestK<T> {
  private readonly heap: T[] = [];

  constructor(private readonly limit: number, private readonly compare: (left: T, right: T) => number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('sample limit must be a positive safe integer');
  }

  consider(candidate: T): boolean {
    if (this.heap.length < this.limit) {
      this.heap.push(candidate);
      this.siftUp(this.heap.length - 1);
      return true;
    }
    if (this.compare(candidate, this.heap[0]) >= 0) return false;
    this.heap[0] = candidate;
    this.siftDown(0);
    return true;
  }

  toSortedArray(): T[] {
    return [...this.heap].sort(this.compare);
  }

  get size(): number {
    return this.heap.length;
  }

  private siftUp(index: number) {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.compare(this.heap[parent], this.heap[index]) >= 0) break;
      [this.heap[parent], this.heap[index]] = [this.heap[index], this.heap[parent]];
      index = parent;
    }
  }

  private siftDown(index: number) {
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let worst = index;
      if (left < this.heap.length && this.compare(this.heap[left], this.heap[worst]) > 0) worst = left;
      if (right < this.heap.length && this.compare(this.heap[right], this.heap[worst]) > 0) worst = right;
      if (worst === index) return;
      [this.heap[index], this.heap[worst]] = [this.heap[worst], this.heap[index]];
      index = worst;
    }
  }
}
