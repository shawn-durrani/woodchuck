- Claude picks up quicker after a pause. Its prompt cache now lasts an
  hour, up from five minutes, so a break in a voice chat or between edits
  doesn't make the next reply write the whole chat to the cache first.
  Writing to the longer cache costs more, and reading it costs the same.
  Set `WOODCHUCK_CACHE_TTL=5m` to go back to five minutes.
