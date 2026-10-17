# D-13: quiz, funnel, and journey read the closed event list (execution-profiles plan §9; P4, P6)

**Decision:** the quiz, funnel, and journey profiles read only the events
the tracker already records (D-01). Funnels are defined in
`src/catalog/funnels.json`. Its `events` list is the six journey event
types of H12 (`product_viewed`, `collection_viewed`, `add_to_cart`,
`cart_viewed`, `checkout_started`, `checkout_completed`), and the catalog
check refuses a funnel step outside it. A journey path is written in the
page types of the session paths and is checked when the profile runs. The
quiz profile picks its pages by their URL and their named tools, and reads
the page datasets over them. A readout that
the site's events cannot support reads `missing` or `conditional` in its
requirement status.

**Rejected:** a properties column on the events, or new event names for a
profile. Either needs tracker work and a new capture contract, and the
closed list already answers the funnel, journey, and quiz questions the
profiles ask.
