# Things that might be changed in the future
#Note:** Speculative future directions, not to be used as agent guidance.

## Re-architect the `fs` interface
Migrate fs from a file-system-like abstraction to a remote store abstraction.
So the amount of new code needed to support, e.g DropBox or WebDav would be reduced.
Needs more study about what the `fs` interface currently does.  Maybe it already is more of a remote store abstraction than the name implies?
But I suspect there's a lot of thunking that could be removed.
Alternatively, maaybe just decide there's never going to be a second remore store and make this a fully gdrive specific plugin!


