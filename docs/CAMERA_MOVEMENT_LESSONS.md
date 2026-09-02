# Camera movement across clips — what went wrong, and what I'd think about next time

Written 2026-08-19 after the "Camera Moves" attempt was reverted. This is
thinking-fodder, not a spec. Plain language on purpose.

---

## 1. What we were trying to solve

The map camera only knows about one clip at a time. So:

- If a project's style is quick "living portraits" (no geographic movement within a clip), the map movement vacillates between stasis and extreme movement (jumping to the next clip) -- visually jarring
- If the camera is zoomed far out, the dot barely crawls.
- If it's zoomed far in and the hiker isn't moving, nothing happens.

The desired solution is a cross-clip conceptual third option to what is now the "follow" playhead toggle. There should a mechanism for creating clip groups. Each clip will provide a "stop" for a new continuous arc. The coordinates for each stop should be based on the clips position in the group. Imagine a 5-clip scenario: 

| Clip   | X-coordinate |
| ------ | ------------ |
| Clip 1 | 0%           |
| Clip 2 | 25%          |
| Clip 3 | 50%          |
| Clip 4 | 75%          |
| Clip 5 | 100%         |
The arc should respect all other map parameters, clip-level or project-level alike. Bearing, zoom, map style, etc. should all impact the new arc.

Additionally, it is critical that the map transition fluidly from its position before the group as well as to the next clips/group's position after.

In terms of UX, creating groups should take place by selecting multiple and clicking a revealed button. Clip groups should be flagged with a small bar that spans the top of the member clips in their carousel. The bar can be dragged to include or exclude adjacent clips and can be selected itself and deleted.

The "follow playhead" should be frozen in a new state called "group" and clicking on it only highlights the group bar described above.

---

## 2. What I built (short version)

A **Move**: a span on the project timeline with a start framing, an end
framing, and a rule for how fast to go between them (by clock time, or by how
far the hiker has walked). Framings were picked from a menu: "the clip's own
framing," "frame the covered route," "follow at zoom N," or "a fixed point."

Underneath, the old per-clip camera model stayed exactly as it was, and Moves
were laid on top with a pile of rules for how the two interact: moves swallow
the automatic transitions they cover, transitions that run into a move get
trimmed and re-aimed, overlapping moves truncate each other, and so on.

The UI was a lane of bars under the clip thumbnails plus a panel of dropdowns.

---

## 3. What actually went wrong

### 3a. I never looked at it

I verified with type checks and 1200 unit tests and never once ran the app
and watched the map move. For a feature whose entire point is "does the
camera motion feel right," that's verifying the wrong thing. The tests prove
the math is self-consistent; they say nothing about whether the result is
good. This is the single biggest failure and it's mine, not the agents'.

### 3b. I designed in ten minutes and then fanned out

I read the compiler for a few minutes, wrote a design doc, pinned the types,
and spun up three agents. That speed felt productive. It meant every judgment
call in the design — and there were a lot — was made before anyone had tried
the simplest possible version by hand. A feature this central deserved one
rough, ugly prototype first, then the design.

### 3c. I bolted on instead of rethinking

The two symptoms exist *because* the clip is the camera's unit. My fix kept
the clip as the unit and added a second unit on top. That's why the design
doc needed rules like "transitions whose cut is strictly inside a move
collapse to zero, but transitions whose window merely runs into a move get
trimmed and retargeted." Every one of those rules is a symptom of two models
fighting. A clean model has one idea for "where is the camera at time t."

### 3d. The UI was a form, not a tool

Choosing "region, padding 0.08" from a dropdown is not how anyone frames a
shot. You frame a shot by looking at the map and moving it until it looks
right. Our preview map isn't even user-draggable today — that's the missing
capability underneath any real camera-authoring UI, and I designed around the
gap instead of naming it.

### 3e. The timeline can't show spans honestly

The clip strip is equal-width thumbnails, not proportional to time. A span of
camera motion laid over that can only be "from clip 3 to clip 6." That was
already a compromise at design time, and I shipped the compromise.

### 3f. Orchestration thrash

The machine kept sleeping and killing agents mid-turn; I re-spawned, resumed,
briefly started doing the compiler myself, found the agent alive, backed off.
None of that broke anything, but it burned the session's attention on
plumbing instead of on the one question that mattered (is this good?). The
rebuild agent then went idle without reporting and the app bundle never
finished. Agents are good at mechanical work against a clear spec; they're
not a substitute for looking.

---

## 4. Simple ideas worth carrying forward

These are the concepts I'd want on the table for the next design, stated as
plainly as I can.

**The camera's path is one continuous line.**
From the first frame to the last, the camera is somewhere. Clips are where
the *video* cuts; they shouldn't automatically be where the *camera* changes
its mind. Whatever the model is, "where is the camera at time t" should be
answerable from one list of things, not two.

**A keyframe is the simplest unit people already understand.**
"At this moment, the camera is here." Put a few of those on the timeline and
the camera glides between them. Every video editor works this way. My "Move"
was a keyframe pair with extra rules; the extra rules were the cost of not
just using keyframes.

**"Follow the hiker" is a special kind of keyframe, not a different system.**
A keyframe can say "be at this fixed place" or "stick to the dot, at this
zoom." Between two follow keyframes the camera follows; between a fixed one
and a follow one it converges onto the dot. That covers today's per-clip
follow mode without a separate mode.

**Today's per-clip settings are just default keyframes.**
Each clip's current framing (zoom, follow on/off) can be read as "a keyframe
at the start of the clip." So the existing behaviour is the zero-effort
starting point, and authoring = adding, moving, or deleting keyframes. No
second model to reconcile.

**Set a keyframe by looking, not by typing.**
Scrub to a moment, drag/zoom the preview map until it looks right, press
"set." That needs the preview map to be interactive and the timeline to be
time-proportional. Both are prerequisites, not nice-to-haves.

**Two kinds of pacing, keep both, but start with one.**
"Move with the clock" (a 40-second push-in) and "move with the hiker" (the
camera advances only when the dot advances). The second is a real and
distinctive idea for this product — but it's an option on a segment, not a
reason to complicate the core. Ship clock-time first.

**The seam between "hand-set" and "automatic" should be one rule.**
The old auto-arc-at-every-cut behaviour is really "if nobody put a keyframe
here, interpolate across the cut." Once keyframes exist, the auto arc is just
the default interpolation between the two clips' default keyframes. Same
machinery, no special cases.

---

## 5. Questions I'd want answered before designing again

- When someone imagines "the map moving across a stretch of clips," what do
  they see first: the *start and end* (keyframes), or the *kind of motion*
  (push in, pull out, orbit, follow)? That decides whether the primitive is a
  keyframe or a move-type.
- How much should the tool decide for you? (e.g. "you selected five clips at
  one spot → here's a slow push-in, adjust if you like.") Good defaults
  matter more than a complete authoring surface.
- Is a time-proportional timeline acceptable with hiking clips that range
  from 3 seconds to 3 minutes? If not, what does the span UI actually sit on?
- Does the preview map become interactive (drag/zoom to frame)? If yes, a lot
  of UI collapses into "scrub, frame, set."

---

## 6. Process rules I'd hold myself to next time

1. Prototype the dumbest version by hand and *watch it* before writing a design.
2. One model for camera position, not two. If the doc needs "absorb / trim /
   retarget" rules, the model is wrong.
3. Direct manipulation before forms. If the UI is dropdowns, stop and ask
   what the user is looking at while they choose.
4. Tests are backup. The deliverable for a motion feature is a video I've
   watched.
5. Agents do mechanical work against a spec I've already validated by eye.
   They don't validate the idea for me.
