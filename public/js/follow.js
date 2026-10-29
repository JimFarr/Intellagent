// Whether a scrolling thread follows its newest entry (INT-493). It follows until the reader scrolls up;
// then new entries are counted instead, and it follows again once the reader is back at the bottom.
export const atBottom = (el, slack = 24) => el.scrollHeight - el.scrollTop - el.clientHeight <= slack;

export function follower(total = 0) {
  let following = true;
  let unseen = 0;
  let last = total;
  return {
    // The reader scrolled: following is just "are they at the bottom".
    scrolled(bottom) { following = bottom; if (bottom) unseen = 0; },
    // The thread now has `count` entries: should it scroll down, and how many are unseen?
    update(count) {
      if (!following) unseen += Math.max(0, count - last);
      last = count;
      return { scroll: following, unseen };
    },
    // The reader's own post, or the chip: follow again.
    jump() { following = true; unseen = 0; },
    get following() { return following; },
  };
}
