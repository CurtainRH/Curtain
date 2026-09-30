pragma circom 2.1.0;

include "ppoi.circom";

// K=3 providers (spec minimum), depth 160 per Curtain_Build.md §1.
component main {public [providerRoots, noteCommit, shieldBlock, originHash]} = Ppoi(3, 160);
