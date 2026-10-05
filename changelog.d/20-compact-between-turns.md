- The summary of a long chat keeps your answers to Claude's questions and
  plans, and every size you asked for, exactly as you gave them. Claude
  can also summarise a long chat between turns, in the background, so no
  turn stops while the summary is written. It's off until you set
  `WOODCHUCK_COMPACT_IDLE_AT`, such as to `100000`. With it on, a single
  very long turn is still summarised as it runs, from 150,000 tokens, and
  the restart gate says `chat_summary` while a summary is being written.
