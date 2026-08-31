# Review document

<span id="rd-c1"><span id="rd-c5"><span id="rd-c6">Select this sentence</span></span></span> to see a comment thread with a reply in it. The thread below it is long enough that the dialog's excerpt box has something to scroll.

## Wording

This sentence includes <ins id="rd-s1">clearer wording</ins>, which is an insertion carrying a reply of its own.

Filler so the next anchor sits below the fold. Roughdraft renders a document at its configured measure, and the rail tracks each anchor's position in the scrolled document rather than its position in the source. Reading down the page should move the current entry along with it.

Filler so the next anchor sits below the fold. An anchor that is already fully visible must not scroll when it becomes current; an anchor below the fold must land in the upper third. Those two cases are the ones worth checking by hand, because a test can assert the arithmetic but not that it feels right.

Filler so the next anchor sits below the fold. The footer replaces the rail below 1100px, and the document must not hide behind it.

## Replacement

Replace <span id="rd-s2"><del>old phrase</del><ins>new phrase</ins></span> here, and confirm the chip reads Replace with no quoted preview text.

Filler so the last anchor sits well below the replacement. Accepting or rejecting a suggestion from the dialog header should close the dialog and make the next entry in the sequence current, with no confirmation step.

Filler so the last anchor sits well below the replacement. The sequence orders document comments first, then anchored entries by their position in the page.

## Removal

Finally, remove <del id="rd-s3">dead text</del> from this line.

---
roughdraft: "1.0"
comments:
  rd-c1:
    body: Root comment
    by: Nora
    at: "2026-04-28T12:00:00.000Z"
  rd-c2:
    body: Nested reply
    by: AI
    at: "2026-04-28T12:01:00.000Z"
    re: rd-c1
  rd-c3:
    body: Looks good.
    by: Nora
    at: "2026-04-28T12:03:00.000Z"
    re: rd-s1
  rd-c4:
    body: Overall, this reads well.
    by: Nora
    at: "2026-04-28T11:59:00.000Z"
    scope: document
  rd-c5:
    body: onetuhoeneuoth
    by: user
    at: "2026-08-31T18:53:02.019Z"
    re: rd-c1
  rd-c6:
    body: oneuhoeunht
    by: user
    at: "2026-08-31T19:01:45.700Z"
    re: rd-c1
suggestions:
  rd-s1:
    by: AI
    at: "2026-04-28T12:02:00.000Z"
  rd-s2:
    by: AI
    at: "2026-04-28T12:04:00.000Z"
  rd-s3:
    by: AI
    at: "2026-04-28T12:05:00.000Z"
