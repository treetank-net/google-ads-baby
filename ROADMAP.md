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
- Prepare and confirm campaign status changes.
- Prepare and confirm campaign removal.
- Prepare and confirm budget changes.
- Create paused Search campaigns.
- Create paused Search ad groups.
- Create paused responsive search ads.

## Target Coverage

### Search

- Add keyword creation for exact, phrase, and broad match.
- Add negative keywords.
- Add Dynamic Search Ads support.
- Add location and language targeting.
- Add stronger validation for responsive search ad headline and description
  lengths.

### Display

- Add paused Display campaign creation.
- Add paused Display ad group creation.
- Add responsive display ad creation.
- Support text fields used by responsive display ads:
  - business name
  - headlines
  - long headline
  - descriptions
  - final URLs
- Support image references for:
  - marketing images
  - square marketing images
  - logo images

### Image Assets

- Add image asset upload from local files or URLs.
- Validate image dimensions, file size, and aspect ratios before prepare.
- Return previews with asset names, dimensions, and intended usage.
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

1. Harden the existing Search flow with keywords and validation.
2. Add image asset upload and reuse.
3. Add responsive display ads.
4. Add Display campaign and ad group creation.
5. Add Performance Max campaign, asset group, and asset group assets.
6. Explore Video and Demand Gen creation.

## Safety Requirements

- No write tool may execute directly.
- Every write tool must return a human-readable preview.
- Every write tool must use a non-empty LLM-generated safe word.
- `confirm_mutation` must reject execution unless the user has confirmed the
  current token with the exact safe word.
- New write tools should include conservative caps for budgets, bids, batch
  sizes, and uploaded asset counts.
