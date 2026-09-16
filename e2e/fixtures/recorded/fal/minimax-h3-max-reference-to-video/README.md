# H3 video replay fixtures

`minimum-grouping-replay.json` contains exact single-shot prompts observed in
the full-pipeline replay after #1658 stopped combining shots that already meet
the model minimum. These are derived replay fixtures, not new live recordings:
they reuse the corresponding scene's durable recorded video as decodable test
media. The original combined-clip fixtures remain available for persisted clips.

Keep prompt matching strict. Changes to grouping or prompt assembly should add
or update explicit fixture prompts, rather than introducing a catch-all match.
