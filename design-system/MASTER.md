# Archive Flow

Node.js / TypeScript + React implementation, rebuilt from scratch after the architecture change.

The primary view is a working surface: configuration cards, cached differences, credential instances and job history. No marketing hero or decorative media.

Use a cool, airy white and blue-gray workspace, restrained green actions, a stable navigation rail, generous card spacing and distinct semantic status labels. Use system fonts for reliable offline Chinese rendering and one Lucide icon family. Layouts adapt at 767 px and 1120 px.

Interactions: 180–220 ms color and opacity transitions; no hover scaling. Respect prefers-reduced-motion. Native dialog focus management, explicit field labels, focus-visible outlines, error text and disabled states. Data fetches must preserve input focus and scroll position.

Read-only views query stored snapshots only. Playlist reads, filesystem scans, Cookie validation and format selection belong to background jobs. Pagination caps mounted diff rows at 100. Never invent data or hide missing dates.

ui-ux-pro-max informed micro-interactions, keyboard focus, form sizing, responsive layout and reduced motion. The generated video-hero and handwritten-font suggestions were rejected as unsuitable for a Chinese backup tool.
