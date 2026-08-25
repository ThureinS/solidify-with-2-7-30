# Schedule mode lives on Item, not User

Adding Adaptive Mode alongside Fixed Mode (see [CONTEXT.md](../../CONTEXT.md)) raised where to store the choice. An account-wide toggle is simpler — one field on `User`, no new per-item UI — but can't express the reasoning that kept Fixed Mode alive at all: some material deserves the effortless zero-click path, other material deserves the accurate one, within the same account. Decided: `mode` is a field on `Item`, chosen at creation, so items in the same account can mix modes.
