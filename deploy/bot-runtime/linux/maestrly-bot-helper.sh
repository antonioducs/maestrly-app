#!/bin/sh
# Compatibility tombstone for older installations. No privileged operations are
# supported until a separate helper authenticates authorization outside the bot.
echo 'ELEVATION_UNSUPPORTED: privileged helper operations are disabled' >&2
exit 1
