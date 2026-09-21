---
name: Dograh Tantei
description: A local workbench for voice-agent tests, recorded evidence, and controlled iteration.
colors:
  paper: '#171c1b'
  surface: '#232b28'
  white: '#1c251e'
  ink: '#edf3e9'
  muted: '#adb9af'
  line: '#46534b'
  sage: '#c5ed72'
  sage-soft: '#1d261f'
  accent-hover: '#d4f598'
  on-accent: '#1c2814'
  header: '#111613'
  pi-surface: '#111914'
  pi-line: '#40543e'
  capacity-line: '#5c734c'
  track: '#394732'
  warning: '#f2c378'
  warning-soft: '#352d20'
  danger: '#ffafa1'
  danger-soft: '#392823'
  overlay: '#070b09b3'
  shadow-color: '#00000033'
typography:
  headline:
    fontFamily: "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif"
    fontSize: '26px'
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: '-0.8px'
  title:
    fontFamily: "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif"
    fontSize: '15px'
    fontWeight: 600
  body:
    fontFamily: "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif"
    fontSize: '12px'
    lineHeight: 1.9
  label:
    fontFamily: "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif"
    fontSize: '11px'
    fontWeight: 500
  button:
    fontFamily: "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif"
    fontSize: '12px'
    fontWeight: 500
    lineHeight: 1.5
  input:
    fontFamily: "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif"
    fontSize: '13px'
    lineHeight: 1.5
  brand:
    fontFamily: "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif"
    fontWeight: 650
    fontSize: '25px'
    letterSpacing: '-0.8px'
  code:
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace'
    fontSize: '12px'
rounded:
  tag: '3px'
  control: '5px'
  panel: '4px'
  brand-mark: '3px'
  primary: '3px'
spacing:
  field-gap: '7px'
  action-gap: '8px'
  row-gap: '12px'
  grid-gap: '16px'
  compact-inset: '18px'
  panel-inset: '23px'
  heading-gap: '28px'
components:
  button-primary:
    backgroundColor: '{colors.sage}'
    textColor: '{colors.on-accent}'
    typography: '{typography.button}'
    rounded: '{rounded.primary}'
    padding: '9px 15px'
  button-primary-hover:
    backgroundColor: '{colors.accent-hover}'
    textColor: '{colors.on-accent}'
  button-secondary:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.ink}'
    typography: '{typography.button}'
    rounded: '{rounded.control}'
    padding: '9px 15px'
  text-input:
    backgroundColor: '{colors.white}'
    textColor: '{colors.ink}'
    typography: '{typography.input}'
    rounded: '{rounded.control}'
    padding: '10px 12px'
  severity-high:
    backgroundColor: '{colors.danger-soft}'
    textColor: '{colors.danger}'
    rounded: '{rounded.tag}'
    padding: '3px 6px'
  capacity-panel:
    backgroundColor: '{colors.sage-soft}'
    textColor: '{colors.ink}'
    rounded: '{rounded.panel}'
    padding: '24px 27px'
  task-card:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.ink}'
    rounded: '{rounded.panel}'
    padding: '19px 19px 17px'
  pi-panel:
    backgroundColor: '{colors.pi-surface}'
    textColor: '{colors.ink}'
    width: '330px'
---

# Design System: Dograh Tantei

## Overview

**Creative North Star: "Dograh Tantei · Graphite"**

Graphite is the user-selected production identity: charcoal surfaces, pale text and a lime action accent. It preserves the approved workbench layout, task cards, focused settings workspace and evidence drawer. There is one fixed theme, with dark native controls and no light/dark toggle.

This record derives from `src/styles/theme.css`, `src/styles/graphite.css` and the feature styles imported by `src/styles.css`. Semantic roles are shared across workbench, Pi, settings and evidence. Legacy CSS names such as `sage`, `paper` and `white` remain role identifiers; they no longer describe literal colors.

**Key Characteristics:**

- Charcoal workspace and panels with lime actions and explicit status text.
- Task cards for overview; compact rows for findings and call evidence.
- Faint capacity grid, lime occupancy and aligned numeric values.
- Modern sans-serif wordmark, dark assistant panel and focused settings navigation.

## Colors

The frontmatter records the production semantic palette. `paper` is the workspace; `surface` holds panels and dialogs; `white` is the darker input surface. `ink`, `muted` and `line` provide text hierarchy and structural boundaries. The header and Pi use their distinct darker roles.

`sage` is the lime primary accent for actions, links, focus and occupied capacity. Filled primary controls use `on-accent` text and brighten to `accent-hover`. `sage-soft` supports capacity, selection and credential summaries. `capacity-line`, `pi-line` and `track` retain the specific boundaries and meter contrast those regions need.

Warning and danger pair bright text with their darker semantic surfaces. State always has text or another explicit cue, not color alone. Native inputs and audio players use `color-scheme: dark`.

## Typography

The interface and wordmark use the local Chinese system sans-serif stack recorded above; no external fonts are required. The wordmark uses weight 650. The Pi symbol retains Georgia, and code and raw events use monospace.

Workbench headings are 26px, reducing to 23px on phones. Task-card titles are 15px at weight 650. Compact workbench descriptions and assistant messages remain 11–12px; transcript text is 12px with generous line height. Settings uses 14px descriptions, labels and inputs, with 30px page and 23px section headings on desktop. Settings headings reduce to 25px and 22px on phones.

Counts, durations and timestamps use tabular numerals. Long evidence, IDs and errors wrap. Small auxiliary metadata is an observed implementation detail, not a recommendation to shrink essential text.

## Layout

The approved layout remains intact. The workbench has a sticky 70px header, a centered workspace up to 1780px wide and a 330px Pi column. Its normal main inset is 35px at the top and 38px horizontally. A shared-capacity region precedes the task-card grid; task details contain the round summary, grouped issues and call evidence.

| Breakpoint      | Implemented behavior                                                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| At least 1450px | Pi widens to 370px; main horizontal inset becomes 54px.                                                                                      |
| At most 1250px  | Task cards change from three columns to two.                                                                                                 |
| At most 1100px  | Pi narrows to 295px; main horizontal inset becomes 25px.                                                                                     |
| At most 900px   | Main workspace becomes one column; capacity stacks; Pi opens separately as a panel up to 390px wide.                                         |
| At most 800px   | Settings categories narrow to 190px with a 26px gap.                                                                                         |
| At most 680px   | Task cards become one column and their bounded scroll region expands into normal page flow.                                                  |
| At most 600px   | Header is 61px; main horizontal inset is 18px; two-column forms stack; Pi can occupy full width; settings categories become a four-item row. |

Settings is a dedicated workspace up to 1220px wide, with a 230px category column and 54px gap. It hides Pi while keeping the chat mounted. Only one of four settings panels is visible; all remain mounted to preserve category drafts. Category-specific saves preserve other categories' drafts.

The body minimum width is 360px. The evidence drawer is at most 680px wide and fills smaller viewports; its header remains visible while content scrolls. Workbench dialogs are at most 780px wide; the concurrency dialog is at most 500px.

## Elevation & Depth

One-pixel boundaries and dark tonal differences define most regions. Task cards have a subtle inset highlight; hover adds a lime boundary, a small shadow and a one-pixel lift. Capacity uses a faint 20px grid. Overlay shadows and backdrops share semantic color roles.

Task-card transitions last 150ms; capacity occupancy changes over 300ms. The evidence drawer enters over 260ms with horizontal translation and clip reveal. Busy indicators rotate once per second. Reduced-motion rules shorten animations and transitions and disable smooth scrolling.

## Shapes

Graphite uses small corners: primary actions and the brand mark are 3px; task cards and capacity are 4px; standard inputs and secondary controls are 5px. Existing grouped summary and composer shapes may retain 7px corners; workbench dialogs use 8px. Status dots remain circular. Underlines and row separators stay straight.

## Components

### Buttons and fields

Primary actions pair lime fill with dark foreground. Secondary actions use panel surfaces and visible edges. Standard buttons have a 38px minimum height; settings buttons use 42px. Inputs share dark fills, semantic boundaries and lime focus. The common focus outline is two pixels with a three-pixel offset. Disabled controls remain visibly dimmed. These are source observations, not a completed touch-target audit.

### Navigation and settings

Header and result navigation use text with active underlines. Settings categories use a dark selected fill and a capacity-colored border. Compact credential summaries identify configured state and source without exposing stored secrets. Provider choices preserve the settings underline language.

### Shared capacity

The capacity panel combines a faint grid, lime active count, numeric usage and supplementary occupancy bars. It shows actual scheduler state, including zero usage when idle. The configured default is 10 with a maximum of 30; changes cannot undercut active occupancy.

### Task cards and evidence rows

Task cards show identity, workflow, goal, progress and issue counts, and open a task's detail view. Dashed progress separators and small corner radii carry the Graphite treatment. Findings and calls remain readable rows; priority labels and timestamp actions stay distinct. Preserve explicit goals and the difference between failed business outcomes and agent misconduct.

### Pi panel

Pi uses its dedicated dark surface, separated context, scrollable messages and a bottom composer. The input and user-message surfaces share dark control roles; lime identifies actions and focus. Narrow-screen Pi opens separately. Settings hides the panel without unmounting the chat.

### Evidence drawer

The drawer groups metadata, native audio, problem markers, findings, transcript and raw events. All share the Graphite palette, including dark native audio controls. Raw events remain in a disclosure with wrapping and bounded scrolling. Keep evidence inspectable rather than hiding it behind decorative summaries.

## Do's and Don'ts

### Do

- Do use shared semantic tokens across workbench, settings, Pi and evidence.
- Do pair lime-filled actions with the dark on-accent foreground.
- Do preserve the approved task-card and focused-settings layouts.
- Do retain explicit status text, aligned numeric values, focus and reduced-motion behavior.
- Do distinguish unavailable evidence, candidate findings and confirmed findings.

### Don't

- Don't introduce a light/dark toggle or promote unselected mockup alternatives into production.
- Don't interpret legacy token names as literal paper, white or sage colors.
- Don't replace evidence or real scheduler state with demonstration activity.
- Don't introduce external font dependencies without updating the local-font contract.
- Don't expose stored credentials in summaries, browser state or examples.
