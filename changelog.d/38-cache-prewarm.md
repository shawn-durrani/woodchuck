- Claude answers sooner after a long pause or an update. When you open a
  design or come back to its window after the cache has gone cold, Woodchuck
  writes the chat to Claude's prompt cache in the background, so your next
  message doesn't wait for it. Another app calling Woodchuck through MCP
  does the same. It happens at most once an hour for each design, or once
  every five minutes on the shorter cache, and costs about what writing the
  chat to the cache costs. Set `WOODCHUCK_CACHE_PREWARM=off` to turn it off.
