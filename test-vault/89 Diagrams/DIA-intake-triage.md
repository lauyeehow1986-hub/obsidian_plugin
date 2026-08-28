---
type: diagram
id: DIA-intake-triage
title: How a request reaches the facility
direction: LR
source: hand
nodes:
  - id: enquiry
    label: Enquiry arrives (email or corridor)
    shape: round
    state: none
  - id: logged
    label: Logged in the eData system
    shape: box
    state: none
    note: The institutional system is the record of truth; this vault tracks the work.
  - id: scoped
    label: Scoped with the requester
    shape: box
    state: none
  - id: feasible
    label: Feasible as asked?
    shape: diamond
    state: at-risk
  - id: renegotiate
    label: Renegotiate the scope
    shape: box
    state: blocked
    note: The most common cause of a bounce, and the reason rework is its own activity category.
  - id: queued
    label: Queued for extraction
    shape: stadium
    state: on-track
  - id: declined
    label: Declined, with a reason recorded
    shape: stadium
    state: done
edges:
  - from: enquiry
    to: logged
    style: solid
  - from: logged
    to: scoped
    style: solid
  - from: scoped
    to: feasible
    style: solid
  - from: feasible
    to: queued
    label: yes
    style: solid
  - from: feasible
    to: renegotiate
    label: not as asked
    style: dotted
  - from: renegotiate
    to: scoped
    label: second pass
    style: dotted
  - from: renegotiate
    to: declined
    label: no viable scope
    style: solid
---

%% scdb:diagram %%

```mermaid
flowchart LR
  enquiry("Enquiry arrives #40;email or corridor#41;")
  logged["Logged in the eData system"]
  scoped["Scoped with the requester"]
  feasible{"~ Feasible as asked?"}
  renegotiate["? Renegotiate the scope"]
  queued(["+ Queued for extraction"])
  declined(["* Declined, with a reason recorded"])
  enquiry --> logged
  logged --> scoped
  scoped --> feasible
  feasible -->|"yes"| queued
  feasible -.->|"not as asked"| renegotiate
  renegotiate -.->|"second pass"| scoped
  renegotiate -->|"no viable scope"| declined
  classDef scdbNone fill:transparent,stroke:#8a8a8a,color:inherit,stroke-width:2px
  classDef scdbAtRisk fill:transparent,stroke:#8a6100,color:#8a6100,stroke-width:2px
  classDef scdbBlocked fill:transparent,stroke:#4a5bd4,color:#4a5bd4,stroke-width:2px
  classDef scdbOnTrack fill:transparent,stroke:#1b6b2f,color:#1b6b2f,stroke-width:2px
  classDef scdbDone fill:transparent,stroke:#8a8a8a,color:#8a8a8a,stroke-width:2px
  class enquiry,logged,scoped scdbNone
  class feasible scdbAtRisk
  class renegotiate scdbBlocked
  class queued scdbOnTrack
  class declined scdbDone
```

%% /scdb:diagram %%

## Notes

Invented. A hand-drawn diagram, deliberately: the three generators draw the
lifecycle from the workflow spec, one request's path from its history, and a
data flow from a request's governance fields — none of them can draw the bit
*before* a request exists, which is where most of the argument happens.

Two things this fixture is here to demonstrate.

**The block above is generated from the frontmatter, and lives between markers.**
Delete the plugin tomorrow and the picture still renders, because core Mermaid
draws it. Prose outside the markers is never touched when the block is
refreshed — this paragraph survives every save.

**States carry a glyph as well as a colour.** `~`, `?`, `+` and `*` are prefixed
into the labels, so the diagram still reads on a projector that renders
everything beige, and in a PNG pasted into a slide deck nobody re-colours.
