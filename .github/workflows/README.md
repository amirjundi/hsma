# No workflows

HSMA is a fork of OpenClaw, and forking brought all 93 of upstream's workflows with
it: Android and macOS releases, Docker publishing, docs translation, QA lab lanes,
CodeQL suites, install smoke tests across platforms.

None of it applies here, and it is not free. Before removal these ran on every push
and on schedule -- one QA lane took 1h 11m, the stale sweep 2h 04m, the performance
suite 52m -- against an account's Actions minutes, testing release infrastructure
this project does not use.

They are deleted rather than disabled, because disabling is per-workflow state that a
later sync from upstream would quietly restore.

If HSMA needs CI later, add one workflow that runs what actually matters:

    pnpm install
    pnpm vitest run extensions/hsma-domain    # the judgement, 123 tests
    pnpm vitest run src/utils.test.ts src/cli # the fork's own changes

A full `pnpm build` takes about twenty minutes, so run it on release tags, not on
every push.
