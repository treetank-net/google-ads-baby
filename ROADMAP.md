# Roadmap

This roadmap captures product goals for Google Ads Baby without account IDs,
customer names, tokens, or other sensitive data.

## Goal

Make the MCP server capable of creating the same broad classes of Google Ads
objects that are commonly used in production accounts, while preserving the
two-phase safety model.

All creation flows should default to safe inactive states:

- campaigns are created as `PAUSED`
- ad groups are created as `PAUSED`
- ads are created as `PAUSED`
- mutating tools require `prepare_*`, user safe word, and `confirm_mutation`

## Current Coverage

- List accessible accounts.
- Run read-only GAQL.
- List campaigns, ad groups, ads, assets, and ad-asset links with filters.
- Build clone-ready ad blueprints for responsive search/display ads.
- Prepare and confirm campaign status changes.
- Prepare and confirm campaign removal.
- Prepare and confirm budget changes.
- Create paused Search campaigns.
- Create paused Search ad groups.
- Create paused responsive search ads.
- Create Search keywords for exact, phrase, and broad match.
- Create campaign-level and ad-group-level negative keywords.
- Add campaign location and language targeting.
- Create paused Display campaigns.
- Create paused Display ad groups.
- Upload image assets from local files or public URLs with dimension and aspect
  ratio previews.
- Create paused responsive display ads with text and image assets.
- Clone supported ads through a generic `prepare_clone_entity` flow.

## Target Coverage

### Search

- Add Dynamic Search Ads support.

### Display

- Validate responsive display image asset dimensions before ad prepare.
- Add clone support for more display-like ad formats when discovered in real
  accounts.

### Image Assets

- Add stricter placement-specific image aspect ratio blocking when the target
  usage is known.
- Reuse existing image assets by resource name when requested.

### Performance Max

- Add paused Performance Max campaign creation.
- Add asset group creation.
- Add asset group asset linking for:
  - headlines
  - long headlines
  - descriptions
  - business name
  - marketing images
  - square marketing images
  - portrait marketing images
  - logos
  - landscape logos
  - YouTube videos
  - call-to-action selection

### Video And Demand Gen

- Explore required fields for Video and Demand Gen creation.
- Add support only after Display and Performance Max flows are stable.

## Implementation Order

1. Harden Display/Image validation, especially image dimensions and aspect
   ratios.
2. Add Performance Max campaign, asset group, and asset group assets.
3. Explore Video and Demand Gen creation.

## Safety Requirements

- No write tool may execute directly.
- Every write tool must return a human-readable preview.
- Every write tool must use a non-empty LLM-generated safe word.
- `confirm_mutation` must reject execution unless the user has confirmed the
  current token with the exact safe word.
- New write tools should include conservative caps for budgets, bids, batch
  sizes, and uploaded asset counts.
