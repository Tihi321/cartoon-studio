# The Blender backend (HUB-30, CTS-18..29; vehicles HUB-31, CTS-31..35)

A series with `renderer: "blender"` (the bible field, default `canvas`) is drawn in 3D: characters and sets are **data** (JSON specs of simple shapes), Python scripts in [`blender/`](../blender) build them in a headless **Blender 5.2** and render the episode with EEVEE, and the engine encodes and mixes the frames with the same ffmpeg code as before. Nothing is an AI picture. The Canvas puppet player still renders `canvas` series (pilots 1 and 2, the `mini` fixture) and is frozen.

Blender is a requirement and is not bundled or downloaded: install Blender 5.2 and check it with `cts_blender_status`.

## Who does what

| Part | Where | Job |
|---|---|---|
| Node side | `src/engine/blender/` (`config.ts`, `runner.ts`, `jobs.ts`, `tools.ts`, `stage.ts`, `library.ts`) | reads `config/blender.md`, checks the version, starts Blender, parses its lines, runs the build, assemble and still jobs as queue jobs |
| Timing | `src/engine/anim/timeline3d.ts`, `visemes.ts` | beats -> `cts.timeline3d/1` (actions with times per language), six-viseme lip-sync from text, audio and whisper word times |
| Render | `src/engine/render/blender.ts` | chunk loop, encode, concat, Flow splice, `muxEpisode`; `cts_render` dispatches on `renderer` |
| Blender side | `blender/run.py`, `blender/cts_blender/` | `build-character`, `build-set`, `sheet`, `assemble`, `still`, `render`, `contact`, `probe`, `reel` |

The engine owns the **timing** (it knows each language's audio lengths); Python owns the **motion** (the acting library). The hr and en films have the same actions in the same order, stretched to their own line lengths.

## Config and the version pin

`config/blender.md` (seed: `seed/config/blender.md`): `path` (default `C:/Program Files/Blender Foundation/Blender 5.2/blender.exe`), `version: "5.2"`, `allowUntestedVersion`, `chunkFrames`, and the `preview` and `final` sizes with EEVEE samples. `cts_blender_config` edits it; Settings shows the path, the version and the GPU.

The runner reads `blender --version` once per engine start. A missing executable is `E_BLENDER_MISSING`; another major.minor is `E_BLENDER_VERSION` unless `allowUntestedVersion` is true. Every run is

```
blender -b --factory-startup --python-exit-code 1 --python blender/run.py -- <job.json>
```

with `PYTHONNOUSERSITE=1`, so a user's preferences and add-ons never change a render. An `AbortSignal` kills the whole process tree. A non-zero exit without a `result` line is `E_BLENDER_FAILED` with the last 40 lines of the log.

## The protocol

The engine writes a **job JSON** (`{ "command": "...", ...inputs and output paths }`) and passes its path after `--`. `run.py` looks the command up in `cts_blender.COMMANDS` and runs it. The Python side prints **one line per event** on stdout, flushed at once:

```
CTS {"type":"progress","done":n,"total":m,"stage":"..."}
CTS {"type":"chunk","index":k,"from":f0,"to":f1,"dir":"..."}
CTS {"type":"result", ...}
CTS {"type":"error","code":"E_FACE_HIDDEN","message":"..."}
```

Anything else (`print`, Blender's own output) goes to the job log. The engine turns `progress` lines into `job.progress` events, uses `chunk` lines in the render (each chunk of PNG frames is encoded to a video segment while Blender renders the next one, then the frames are deleted), and returns the `result` fields to the caller. An `error` line is a coded failure the tool shows (`E_FACE_HIDDEN`, `E_SET_INVALID`, `E_ACTION_UNKNOWN`, `E_MARK_UNKNOWN`, `E_SHOT_UNKNOWN`, `E_ASSEMBLE_FAILED`); a Python exception becomes `E_BLENDER_FAILED`. Raise `io.CtsError(code, message)` in a command for a coded failure.

A command is `@command("name") def run(job): return {...}` in a module listed in `COMMAND_MODULES` (`blender/cts_blender/__init__.py`). The returned dict is the `result`.

## Blender 5.x gotchas (from the probe)

All of them live in `blender/cts_blender/api5.py` and nowhere else, so a Blender update breaks one file, and `yarn test:blender` fails there first.

- `Action.fcurves` is gone. Curves live in a **channelbag** of the action slot (`bpy_extras.anim_utils.action_get_channelbag_for_slot`). Dense channels are written with `keyframe_points.add` + `foreach_set` through `api5.write_dense`.
- `keyframe_new_interpolation_type` is **ignored in background mode**: set the interpolation on the keyframes after keying (`CONSTANT` for mouths and lids, `LINEAR` for dense motion).
- The compositor has **no Composite node**: the tree is a node group with a Group Output (`scene.compositing_node_group`), and mixing uses `ShaderNodeMix`.
- Workbench shows the inverted-hull outline shell over everything unless **backface culling** is on in the shading (EEVEE: `material.use_backface_culling`). Workbench is only an emergency fallback: it was not faster in the probe.
- `gpu.platform` answers only after `gpu.init()` in a background run.
- Sun shadows are off on purpose (the inverted hull would shadow its own object); the ground "shadow" is a blob under each character.
- A face feature buried inside the head is invisible: the character builder ray-tests the eyes and mouth (`E_FACE_HIDDEN`).
- Blender keeps the file it overwrote as `scene.blend1`; the assembler deletes it.

## Build, assemble, render

1. **Character** (`cts_character_set` writes `cast/<id>/character.json`, `cts_character_build` runs `build-character`): primitives on parented empties (`root`, `squash`, `body`, `head`, `arm_L/R`, optional legs, ears, tail, accessory chains, `lid`, `brow`, `pupil`, six mouth slots), outlines, face ray test, `character.blend`, `build.json` (spec hash) and the turnaround `sheet.png`. The user approves the sheet (`cts_sheet_approve`, which records the spec hash).
2. **Set** (`cts_set3d_set`, `cts_set3d_build`): ground, sky, props from the kit, marks, named cameras, `set.blend`, `sheet.png`.
3. **Timeline** (`cts_timeline_build`): `timeline.<lang>.json` (`cts.timeline3d/1`) and `lipsync/<lang>/<line>.json`.
4. **Assemble** (`cts_scene_assemble`): appends the assets, places the actors on their marks, runs the acting library, keys mouths, lids and pupils, frames the camera shots, adds the title cards and writes `render/<lang>/scene.blend` and `assembly.json` (actions, shots, spec and asset hashes). The render rebuilds the scene when the timeline, a character spec or asset, or the set changed since.
5. **Render** (`cts_render`): chunks of `chunkFrames`, `render_pre`/`render_post` handlers time every frame into `render/<lang>/blender-times.json` (first frame, warm mean, p95, total); the engine encodes each chunk (`h264_amf`, else `libx264`), joins the segments, splices real Flow clips in a final render and runs `muxEpisode` (mix, loudness, `mix-check.json`). Preview mode renders at 50 % with 4 samples.

The look is one file per series, `style3d.json` (`cts.style3d/1`): the toon ramp, outline colour and scale, sky, sun, samples, `post: none | paper | posterize`, `stepped`. The guide the designer roles read is `seed/style/toon-3d.md`.

## Vehicles: cars and trains (HUB-31)

A character is a **creature** (the default: a body, a head, arms, maybe legs) or a **vehicle** (`kind: "vehicle"` in `cts.character3d/1`): a car or a train with **no arms and no legs**. The contract is in `docs/contracts.md`; the guide with the Pip-car and Bruno-engine example specs is `seed/style/toon-3d.md`.

- **Controls.** `root` (on the running surface) > `squash` (the suspension) > `body` > `head` (the front block with the face), `lid_L/R`, `pupil_L/R`, `mouth`, and one `wheel_<n>` per wheel on `root`. Optional: `brow_L/R` (the lamp visors), `chimney` and `exhaust` (puff sources), `horn`, `antenna1..n` (a spring chain; CTS-41: its input acceleration bends over at 6 m/s2 and it meets a soft stop before its 40 degree limit, so a hard `zoom` swings it without pinning it), `acc_<name>1..n`. An `arm_*`, `hand_*` or `leg_*` control is lint `E_VEHICLE_LIMB`.
- **The face: lamp eyes and a bumper mouth.** The eyes are the vehicle's own two front lamps (a domed lens, a hood that is the lid, a pupil disc; the lens glows with `head["lamp_glow"]`, 0..1, keyed by the acting library), the mouth is the bumper slot (a car) or the buffer-beam slot (a train) with the six viseme shapes. No eyes in a windscreen or a cab window, no face on a round smokebox door, no nose and no cheeks. The builder ray-tests the lamps and the mouth against the body (`E_FACE_HIDDEN`) and the visors (`face.brows`) as a warning (CTS-41: "the L visor is buried in the body"; the fixture Bruno's visors sit inside its nose box and warn).
- **The `vehicle` block.** `{ type: "car" | "train", wheelRadius, wheels: [controls], track }`. A train has `track: true` and moves only along a `track` path. Its wheels run on the rails: their `x` is half the gauge (±0.48 m on a 1.6 m track).
- **Motion.** `motion.drive { style: "zip" | "chug", topSpeed (m/s), accel (m/s2), suspension 0..1 }` instead of `motion.walk`.
- **The builder** (`build_character.py`) makes cylinder wheels with hubs on their `wheel_<n>` controls, the lamp eyes, the bumper-mouth slots, a pool of 8 cloud puffs per `chimney` or `exhaust` (hidden at rest), and the antenna chain. Its `build.json` has a **vehicle block**: `{ type, track, wheelRadius, length, width, height, wheels: [{control, radius, axis: "x", forward: 1, side, at}], lampGlow: {control: "head", prop: "lamp_glow"}, puffs: {chimney|exhaust: {count, outlet, radius, objects}}, antenna: [...] }`. The sheet gets a fourth row, the **motion strip**: squash, stretch, lean left and right, nose up, honk (the lamps glowing) or puff.

### Paths and the road-and-rail kit

A `cts.set3d/1` set may have `paths: { <id>: { kind: "road" | "track", points: [[x, y], ...], width? } }` (default width: road 3 m, track 1.6 m). The set builder (`build_set.py`) makes each path a poly curve `path:<id>` at ground level with `cts_path`, `cts_path_kind`, `cts_path_width`, `cts_path_length` and `cts_path_surface` (the height a wheel bottom runs on: the asphalt top `ROAD_TOP` 0.012 m, the rail top `RAIL_TOP` 0.2 m). The kit adds `road` and `track` (built along their `path`), `crossing` (boards over the rails where a road meets a track, with a 0.7 m ramp at half height on each side, a raised barrier and a cross sign), `platform`, `signal` and `buffer_stop`. `build.json` lists `paths` (`{kind, points, width, length, surface, gauge?}`), `railTop` and `crossings` (`[{id, at, rot, top, track, road}]`). When a set has paths, the **set sheet** gets a third row: the set from above with the paths drawn over it and the marks labelled (`sheet.png` is then 2048 x 1728 instead of 2048 x 1152).

Lint: `E_MARK_OFF_PATH` (a mark a vehicle moves from or to is more than 0.3 m from a path of its kind), `E_OFF_TRACK` (a train's two marks are not on one track), `E_PATH_BLOCKED` (a path runs through a prop's footprint), `E_ACTION_BODY` (an action the body cannot do).

### The vehicle actions

Every action in `library.json` names its `bodies` (`creature`, `vehicle` or both) and, for a vehicle action only a car or only a train does, `vehicleTypes`. The creature actions stay as they were (pilot 3 re-renders unchanged).

| Kind | Actions |
|---|---|
| Automatic | `idle_engine` (a suspension bob and an engine shiver), `blink` (the lamp hoods), `look_at` (pupils lead, then the front block; a car's body turns only when stopped and past 60 degrees, a train never yaws), the talking and listening automation |
| Locomotion | `drive`, `zoom`, `reverse` (a car), `chug` (a train), `turn` (a car only, a short arc bent back so the car ends on the line of the road it stood on (CTS-41); a train never turns) |
| Gestures | `nod`, `shake_head`, `bounce`, `lean`, `tilt`, `wiggle`, `rev`, `honk` (a car), `whistle` (a train), `puff`, `flash`, `wink`, `point_nose`, `spin_wheels`, `park`, `start_up` |
| Reactions | `react_surprised`, `laugh`, `droop` |

A move along a path takes `params = { path: [[x, y], ...], z, stop? }` (or `target`): an anticipation (the rear squats), then the move arrives at `t1` with the wheels rolling exactly distance / `wheelRadius`, the body pitching and rolling on the suspension and settling after the stop; a chug puffs every `puffEveryM` metres. `honk` and `whistle` are sounds: the writer pairs each with an `sfx` beat. `vehicle.nominal_seconds(spec, distance, style)` is the usual duration of a move.

### Timeline and assembly of a vehicle series (CTS-35)

- **Timeline** (`timeline3d.ts`): a `move` of a vehicle runs the beat's style (else `drive` for a car, `chug` for a train). When the vehicle and the end mark are on one path of its kind, the action gets `path` (the stretch of the path between them, `pathBetween` in `src/engine/blender/props.ts`) and `pathId`; a train whose end mark is off its track goes to the nearest point of its track (a warning; lint says `E_OFF_TRACK`), and a train's `turn` is dropped. The move lasts the beat's seconds, at least the vehicle's usual time over 1.25 (`vehicleSeconds`, the twin of `nominal_seconds`), within the library's min and max. A vehicle starts facing along its path, the way its first move goes.
- **Assembly** (`assemble.py`): a vehicle stands on its start mark at the running surface of the nearest path of its kind (the road top for a car, the rail top for a train; the ground when there is none). A move gets `z` from its `pathId`. A car that crosses a track rides up over the crossing boards and their ramps (`ctx.surface`, the mean of what is under its front and rear axle). The blob shadow lies on what is under the vehicle (`floor`: the road, the sleepers, the boards). The puff pools, the lamp control and the objects of each vehicle go to the channel writer, which keys the puffs and the lamp glow.
- **Framing** (`acting/framing.py`): with a vehicle in the shot, `wide` and `two` take each body's ground extent from its rest box (turned with its yaw, nearer corners counted wider for the perspective) and the wide camera sits higher, so a long engine is framed whole and seen over (CTS-41: when a vehicle body between the camera and another actor still hides that actor's face or top, a ray test against the body boxes, the wide camera rises to 0.5, 0.75 or 1.05 of its distance until both are seen; pilot 4's camera is unchanged by it); `cu-<vehicle>` frames the face (the lamp eyes and the mouth) from in front of it, turned a little toward the default camera side (a three-quarter view); `ots-<a>-<b>` with a vehicle `a` stands beside its face. Shots of creatures only are computed as before.

## Tests

- `yarn test:blender`: `blender -b --factory-startup --python-exit-code 1 --python blender/tests/run.py` (unittest in Blender's own Python, no pip installs). It fails, not skips, when Blender is missing. It covers the runtime shims, the character build (controls, mouth slots, outlines, `E_FACE_HIDDEN`, deterministic hashes), the look, and the acting library (the registry equals `library.json`, gestures return to rest, feet stay planted in a walk, a tail spring settles).
- `yarn test:e2e`: `tests/blender.e2e.test.ts` builds the vehicle fixture `mini-vehicles` (a car and a train on a road-and-rail set), assembles it and renders 2 s of a small preview with real Blender, next to the canvas render e2e.
- The Blender tests also cover the vehicles: B1v (the `mini-vehicles` car builds with wheels, lamp eyes, six mouth slots and no limb; a buried lamp is `E_FACE_HIDDEN`), B2v (the registry's `bodies` equal `library.json`; in a 5 m `drive` the wheels roll the root's path length within 2 % and stay on the ground; a `turn` ends on the road's line; in a `chug` the wheels stay on the track; `honk` and `bounce` return to rest) and B3 (the paths are curves that follow the spec and carry their running surface, the crossing lies across the track).
- `yarn test`: fast, no Blender (the runner and the pipeline use a fake runner).

## How to add an acting action

The acting library is `blender/cts_blender/acting/`; `library.json` is the **single source of the names** (the engine reads it for lint, the writer prompt and the timeline, and test B2 fails when the Python registry and the file differ).

1. Write the function in the family module (`gestures.py`, `gait.py`, `vehicle.py` or `camera.py`): `@action("name", bodies=...) def name(ctx, actor, t0, t1, params): ...` (`bodies` defaults to `("creature",)`; a name both bodies share is one function that branches on `vehicle.is_vehicle(actor)`) returns a `Clip` of contributions to the actor's layers (`base`, `idle`, `gesture`, `head`, `look`, `face`, `secondary`). Follow the principles in `acting/__init__.py` and `core.py`: anticipation, slow in and out, overshoot and settle, overlap (the head lags the body), arcs (rotations about the shoulder), moving holds, scaled by the character's `tempo`. Keys must stay inside `[t0, t1 + settle]` and return to the rest pose.
2. Add the entry to `library.json`: `name`, `kind` (`gesture | locomotion | react | camera`), `bodies`, optional `vehicleTypes`, `parts` (the controls it moves; `wheel_*`, `antenna*`, `lamp_glow` for vehicles), `seconds {min, default, max}`, `overLine` (may it overlap a line of dialogue), `needsTarget`, `params`.
3. If a script should be able to use it by name, it comes through the script's `gesture` beat (`gesture` names come from the manifest), and `move.style` for locomotion. No engine code changes are needed for a new gesture name.
4. Run `yarn test:blender` (B2 checks the registry, the rest pose and the settle time) and look at the `reel` command's contact sheet.

## How to add a prop to the set kit

The kit is `blender/cts_blender/props.json` (`kinds`: `footprint` in metres and the `colours` keys a set may override) plus one builder method per kind in `build_set.py`.

1. Add the kind to `PROP_KINDS` in `src/shared/contracts.ts` (the `cts.set3d/1` schema) and to the table in `docs/contracts.md` (`yarn docs:check`).
2. Add `"my_kind": { "footprint": ..., "colours": [...] }` to `props.json`.
3. Add `def _my_kind(self, pid, root, c)` to the set builder in `build_set.py`: build the shapes with the builder's helpers under the prop's root empty, taking colours with `c("key", default)`. Keep it a few primitives with an outline (the look is part of the style). If the actors can sit on it, honour `seat`.
4. Mention it in `seed/prompts/background-artist/set-spec.md` (the kit table the designer reads) and build a set with it; read the set sheet.

## Licence

Scripts that `import bpy` are generally treated as covered by Blender's GPL when distributed, so `blender/` is **GPL-3.0-or-later** (`blender/LICENSE`, an SPDX line in each file). The rest of the repository is MIT. The engine starts Blender as a separate program and talks to it only through a JSON file and stdout lines.
