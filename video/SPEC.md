# CKB ClearSign — demo film spec

```text
GOAL:    A CKB developer ends the film knowing one thing: ClearSign re-hashes each input's
         origin tx before signing, so a lying RPC is caught, and they open the repo.
OUTPUT:  HyperFrames, 1920 x 1080, 30 fps
TIME:    scene 1 40 s + scene 2 60 s (variable: #demo data-duration) + scene 3 15 s
         = 115 s x 30 = 3450 frames. No music bed yet (no catalog sign-in); SFX only.
LOOK:    medium = an engineering schematic drawn live on a dark board.
         ground  #0B0F14 (var --bg) with a 1 px #131A22 grid every 60 px (structure, not decoration)
         ink     #FFFFFF (var --ink) for every word that must be read; muted #8A96A3 (var --muted)
         accent  #3CC68A (var --accent): only on ClearSign itself, "verified", the Sign button
         danger  #FF4D4F (var --danger): only on the lie, the loss, the mismatch
         lines   #2A3542 (var --line), 2 px strokes, 14 px radius on boxes, no shadows, no glow
         display Inter 900, 168 px title / 72-96 px lines / 44-56 px body, tracking -2% on >=72 px
         mono    JetBrains Mono 400/700, 28-36 px, for hashes, RPC calls, error codes
         grain 0%, vignette 0%, shadow none
OBJECTS: Wallet = a phone (380x680, 44 px radius, notch bar, screen rows like a real wallet)
         RPC    = a server box (3 drive bays + status LEDs), labelled "RPC node"
         Chain  = three linked block squares; the real cell drops out of one as a card
         ClearSign = a green-stroked box that physically sits in the wire between wallet and RPC
         blake2b = a box with a round counter 0→12 and a progress bar; bytes enter, a hash leaves
         Hashes  = the real ones from `npm run demo -- --offline`:
                   out point 0x6c83a29b95ab3e18161f30e05b127900df9ca1b9e502e8df9f16d95e76e47a87
                   recomputed 0xd575aa26f26e10fcfc169824c7181266a189d9e0c8570113878d9df97a32bc9d
MOTION:  enter  expo.out 0.5-0.7 s (15-21 f); move power2.inOut 0.6-0.9 s; exit power3.in 0.25-0.35 s
         camera push power2.inOut 1.0 s; wires draw linear-ish power1.inOut 0.5 s
         word stagger 0.07 s; list stagger 0.06 s; no springs, no back/elastic eases
         titles land and hold dead still
SHOTS:   S1 (0-40)
         0.0-4.0   title per-word blur-in, subtitle grey→white; out point hash types in under it
         4.0-14.0  diagram grows: phone (4.2) → wire → RPC (4.8) → ask bubble (5.6) → answer
                   "61 CKB" (7.0) → phone row shows 61 → RPC stamped COMPROMISED (8.8) → chain
                   + real cell "10,061 CKB" (10.6) → hold
         14.0-22.0 camera pushes into the phone (1.0 s); review screen; Fee 0.0001 highlighted;
                   tap Sign (17.4, click); red flash (18.0, impact); row flips to 10,061;
                   "10,000 CKB gone" + "Real fee 10,000.0001 CKB → miners"; hold to 21.8
         22.0-23.2 rewind: frame smears left with horizontal blur, red drains (glitch sfx)
         23.2-34.0 nodes row: wallet · ClearSign drops into the wire (24.0) · RPC (red);
                   getTransaction(0x6c83…) packet (25.0); origin tx card returns (26.0) with
                   capacity 61 CKB; bytes enter blake2b (27.2-28.6); recomputed hash wipes out
                   (28.6-29.4); compare: out point (left) ≠ recomputed (right) (29.8-31.0);
                   flood red + ORIGIN_TX_HASH_MISMATCH + "blocked before signing." (31.4, error sfx)
         34.0-40.0 red drains; "A CKB out point is the origin tx hash." ("is" in accent) with the
                   out_point struct under it; 36.6 "Re-hashing makes lying impossible."; hold
         S2 (40-100, length = #demo data-duration)
         heading; terminal window 1280x760 with traffic lights and title "npm run demo";
         recording (or placeholder card) inside; callouts stack in the right column at
         6 / 24 / 42 s scene time (edit data-start), previous one dims to 45%
         S3 (100-115)
         0.0-5.0 two flags, check then cross, honest; 5.0-8.6 nested boxes grow
         (CCC signer → ClearSign → Wallet) under the "Ships as…" line; 8.6-11.4 roadmap path
         draws through three stops; 11.6-15.0 end card URL, landed by 12.0, held 3 s
BANNED:  glow/bloom/neon, particles, gradients, glass cards, pill chips, corner labels/HUD,
         three cards in a row, everything centred, everything fade+slide-up, bouncy eases,
         click rings, breathing/pulsing loops, text moving while read, logo in a corner,
         "01/02" numbering, small mono caps labels as decoration
QA:      t=2.5 title read; 9.5 compromised stamp; 12.5 full diagram; 19.5 loss frame;
         28.0 blake2b; 31.0 compare; 32.5 red mismatch; 38.5 line; 41 + 30 terminal/callouts;
         101 flags; 108 nested boxes; 111 roadmap; 114 end card
```
