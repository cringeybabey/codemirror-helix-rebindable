import { type SearchQuery } from "@codemirror/search";
import { cmdCount } from "./commands";
import { NonInsertMode } from "./entities";
import { EditorState } from "@codemirror/state";

type Match = { from: number; to: number };

export function backwardsSearch(
  state: EditorState,
  query: SearchQuery,
  mode: NonInsertMode,
  select: (match: Match) => void
) {
  type Match = { from: number; to: number };

  const cursor = query.getCursor(state);
  const selection = state.selection.main;

  const count = cmdCount(mode);
  const beforeRing = new Ring<Match>(count);

  const iter = peekable(cloned(cursor));
  const beforeIter = peekingUntil(iter, (item) => item.to >= selection.from);

  for (const item of {
    [Symbol.iterator]() {
      return beforeIter;
    },
  }) {
    beforeRing.push(item);
  }

  if (beforeRing.length === count) {
    select(beforeRing.first);
    return;
  }

  const afterRing = new Ring<Match>(count - beforeRing.length);

  for (const item of {
    [Symbol.iterator]() {
      return iter;
    },
  }) {
    afterRing.push(item);
  }

  const total = afterRing.length + beforeRing.length;

  if (total === 0) {
    return {
      match: false as const,
    };
  }

  if (total === count) {
    select(afterRing.first);
    return {
      wrapped: true as const,
    };
  }

  const all = [...beforeRing, ...afterRing];
  const rem = count % total;

  select(all[all.length - rem - 1]);

  return {
    wrapped: true as const,
  };
}

class Ring<T> {
  items: T[];
  head: number;
  length: number;
  maxLength: number;

  constructor(length: number) {
    this.items = Array.from({ length });
    this.maxLength = length;
    this.head = 0;
    this.length = 0;
  }

  get first() {
    return this.items[this.start];
  }

  push(item: T) {
    this.items[this.head] = item;
    this.head += 1;
    this.length += 1;

    this.head %= this.maxLength;
    this.length = Math.min(this.maxLength, this.length);
  }

  merge(other: Ring<T>) {
    for (let i = 0; i < other.length; i++) {
      const item = other.items[(other.start + i) % other.maxLength];
      this.push(item);
    }
  }

  *[Symbol.iterator]() {
    for (let i = 0; i < this.length; i++) {
      yield this.items[(this.start + i) % this.maxLength];
    }
  }

  private get start() {
    if (this.length < this.maxLength) {
      return 0;
    } else {
      return (this.head + 1) % this.maxLength;
    }
  }
}

function peekingUntil<T, R, N>(
  iter: ReturnType<typeof peekable<T, R, N>>,
  check: (next: T) => boolean
) {
  return {
    next() {
      const item = iter.peek();

      if (item.done) {
        return item;
      }

      if (check(item.value)) {
        return { value: undefined, done: true as const };
      }

      return iter.next();
    },
  };
}

function peekable<T, R, N>(iter: Iterator<T, R, N>) {
  let next = iter.next();

  const peekIter = {
    next() {
      const item = next;

      if (!item.done) {
        next = iter.next();
      }

      return item;
    },
    peek() {
      return next;
    },
  };

  return peekIter;
}

function cloned<T, R, N>(iter: Iterator<T, R, N>) {
  return {
    next() {
      return { ...iter.next() };
    },
  };
}
