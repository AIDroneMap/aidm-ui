---
status: accepted
date: 2026-10-29
---

# Options are explained by a catalogue whose facts and words live apart, and the engine's own list wins

The engine has about ninety options. The interface shows sixty-three of them, each with a plain name, one line on what it does, when to change it, what it costs and an example a pilot recognises. Those explanations are the product. Every string the operator sees must live in the translation file, and the server must check values against each option's type and domain before it creates a task, without ever touching interface text. Every engine an operator attaches may run a different version with a different option list.

We decided to split the catalogue by kind. The facts live in one data file in `shared/`, read by the server and the interface alike: engine name, group, type, domain, default, which presets set it and to what, which options it depends on, and a cost tag taken from the engine's own help text where it gives one. The words live in the translation file, keyed by option. When the operator opens the settings for a run, the server fetches the chosen engine's option list and the interface reconciles it with the catalogue: an option the engine reports and the catalogue lacks is shown in a last group with the engine's help text and a marker, never hidden; an option the catalogue has and the engine lacks is hidden for that run; where type, domain or default differ, the engine's values win and the entry is marked. Options that need a file, options for more than one machine, and options that steer the engine's own process stay hidden by name whatever the engine says. The same reconciliation runs in CI against the task API in test mode, so an engine release with new options fails a test here before it surprises an operator.

The explanations are written from the engine's source and the stages that read each option, never from another project's documentation. Ideas may be learned, text is never taken.

## Considered options

- One file per language holding facts and words together. Rejected: the server would load interface text to validate a number.
- Trusting the catalogue over the engine. Rejected: a hidden option is a silent lie about what the engine will do.

## Consequences

- The data file and the translation file are checked against each other by a test: five texts for every shown option, no text for an unknown option.
- A new engine version lands in the catalogue through a pull request that a maintainer reviews entry by entry.
