# Review: CKB ClearSign demo (v1, before render)

## Creative calls
- The story is fixed by the brief, so I skipped the three-storylines step. The look is an
  engineering schematic on #0B0F14 with a 60 px grid. Every object reads as itself: a phone
  wallet, a server box for the RPC, linked blocks for the chain, and a green box that sits in
  the wire for ClearSign.
- **The hashes are real.** They come from `npm run demo -- --offline`: out point `0x6c83a29b…7a87`,
  recomputed `0xd575aa26…bc9d`. They match what the terminal recording will show.
- **Fee arithmetic:** the RPC under-reports input #0 (61 instead of 10,061 CKB). The wallet shows
  output 60.9999 CKB and fee 0.0001 CKB. The real implicit fee is 10,000.0001 CKB, so "10,000 CKB
  gone, paid to miners".
  ⚠ **This is the reverse of `demo/fake-rpc.ts`.** There, the lying RPC *inflates* input #0 by
  +10,000 CKB. Both are valid attacks and ClearSign catches both the same way. Viewers who compare
  the two may notice, so a callout like "the demo's RPC lies the other way: +10,000" may help.
- Added one beat that wasn't in the brief: "Looks fine." (16.2–18.0 s). It fills the empty right
  half while the user reads the fee, and it sets up the loss. You can edit it with the `fineText`
  variable or delete it.
- "Side by side": the two hashes sit in two columns, three lines of 22 characters each, with a
  red ≠ between them.
- The outro's next steps are drawn as a roadmap line with three stops, not three cards. The end
  card lands by 12.0 s and holds still for 3.0 s.

## Editing
- Every line of copy and every colour is a root variable on `index.html`, grouped as S1/S2/S3 and
  "Colour ·" in the Variables panel. Scenes don't redeclare them (I tested this: root values do
  reach the scenes). Colour tweens read the variables at seek time.
- **Scene 2 length:** drop your clip at `assets/demo.mp4`, then run `node scripts/set-demo.mjs`.
  It probes the clip, then sets `#demo`'s duration, the root duration (40 + clip + 15), the callout
  end times and the outro whoosh, and swaps the placeholder for a muted `<video>`. To force a
  length, run `node scripts/set-demo.mjs 72.5`. I tested it on a copy with a 72 s test clip:
  check ok, and the clip plays inside the terminal window.
- The callouts start at 6 / 24 / 42 s of scene time. Retime their `data-start` to match the
  recording. The pops in `index.html` (`sfx-pop1..3`, at 40 + start − 0.08) need the same shift.

## Measured vs looked at
- `check --json`: ok, no errors. I snapshotted every beat in SPEC.md's QA list, plus the review
  sheets (beats, both seams, phone width) and the seams again after the fixes.
- **Sound:** there is no music bed. HeyGen isn't signed in here, so the music catalog wasn't
  available. The SFX are bundled (click, impact, glitch, error, whooshes, pops), each placed so its
  peak lands one frame after its picture, using measured peak times. Nobody has heard the mix. To
  add music, run `npx hyperframes auth login` (free), then ask me for a bed, or drop a track at
  `assets/music.mp3` and add `<audio id="music" data-volume="0.12">`.
- **Emoji** (✅ 🛑 ❌) render from this machine's Noto Color Emoji. A machine without an emoji
  font would show blanks there.

## Fixed in review
- P1, 28 s: the byte chunks overlapped the origin-tx card edge. Moved them to the gap and gave
  them a backing.
- P1, 15–18 s: the right half was empty while the phone was pushed in. Added "Looks fine."
- P1, seams at 40 s and 100 s: ~0.3 s of empty frame. The demo now enters on its first frame and
  blurs out at its own end (computed from the clip length). The outro's first flag starts at 0.
- P2, 15 s: the pushed-in phone sat 4 px outside action-safe. P2, outro: the nested boxes were
  too tall for their content.

## Warnings kept on purpose
- `line_unread` on the origin-tx card (26.3 s): the card is code texture. The one value that
  matters, `capacity: 61 CKB`, is red and on screen for 3.6 s.
- `subcomposition_blanks_before_host` (#problem): scene 1 is meant to end at 40 s. The scenes are
  sequential.
- `timeline_track_too_dense` / `composition_file_too_large` (problem.html): the brief asks for 3
  scenes, so scene 1's five beats live in one file.
- info `text_occluded` (strike-through over the fee) and `content_overlap` (bytes entering
  blake2b): both intended.

## Weakest shot
The rewind (22.0–23.3 s) is just streaks plus a label. With more time I'd reverse the
diagram on screen: the red drains, the phone pulls back out to the diagram, and then the
ClearSign box drops in.
