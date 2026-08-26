## Development workflow

- Typecheck: `npm run typecheck` (tsc --noEmit)
- Build: `npm run build`
- Development server: `npm run dev` (runs server + vite concurrently)
- Check ports before starting another server.
- Prefer reusing an existing healthy development server.
- Main conversation UI: `src/components/Conversation.tsx`
- Conversation styling: `src/styles/conversation.css`
