# 0020 — Licensing model: source-available, non-commercial by default

- Status: Proposed (draft documents; legal review required before this is treated as final)
- Date: 2026-11-19
- Supersedes: [0001](0001-product-scope.md), decision 5 (licensing only)

## Context

ADR-0001 decided that "V0.1 is local-first and open source (MIT)", and the
repository has been distributed under the MIT License since its first commit.
The owner's actual policy is different: commercial use, selling, sublicensing
and commercial redistribution are meant to require explicit permission, and the
VOLDBASE name and visual identity are meant to identify this project only.

MIT cannot express that policy. It grants everyone the right to use, copy,
modify, merge, publish, distribute, sublicense and sell the software, for any
purpose, including commercial and internal business use, royalty-free and
irrevocably. Keeping MIT in `LICENSE` while documenting a non-commercial policy
elsewhere would leave two contradictory grants in the same repository, and the
more permissive one would win for anyone who relied on it.

The repository is also only at the stage of documenting a policy: it has not had
legal review, the governing law is not chosen, and the copyright holder line is
being corrected from a GitHub handle to a person's name. A final license cannot
honestly be claimed yet, and the documents must not pretend otherwise.

## Decision

1. **Replace the MIT license text with a clearly labelled draft** of a
   source-available, non-commercial license in `LICENSE`, versioned `0.1-draft`.
   The draft states that it has not been legally reviewed and is not a claim of
   enforceability, in its own first section rather than in a footnote.

2. **Grant non-commercial permission and reserve everything else.** Personal,
   educational and other non-commercial use, personal non-commercial
   modification, non-commercial redistribution of unmodified copies, and
   non-commercial contributions are permitted. Commercial use (including purely
   internal business use), selling, sublicensing and commercial as well as any
   distribution of modified versions require prior written permission.

3. **Define scope explicitly.** `LICENSE` section 3 lists covered paths
   (`src/`, `bin/`, `tests/`, `docs/`, original root documents and
   configuration) and excludes third-party components, contributors' work, the
   Brand, and any file carrying its own header. Third-party material is governed
   by its own license; contributor copyright is never claimed.

4. **Add `NOTICE`.** It carries the copyright line, the third-party component
   table with licenses, the prior-licensing (MIT) record, the contributor
   position, and statements that the current version does not execute imported
   project code and does not provide a validated security guarantee.

5. **Add `TRADEMARKS.md`.** Name, logo and visual identity are not licensed by
   `LICENSE`. Factual references are allowed; anything suggesting official
   affiliation, or naming a fork VOLDBASE, is not. No trademark registration is
   claimed.

6. **Remove the machine-readable MIT grant.** `package.json` no longer declares
   `"license": "MIT"`; it uses the npm convention `SEE LICENSE IN LICENSE`, and
   the lockfile root entry follows. This is metadata only: no source file, test,
   build output or application behavior changes.

7. **Do not rewrite the historical record.** ADR-0001 is marked superseded for
   its licensing decision only; its product-scope decisions remain in force. The
   README license section is corrected so no current document still advertises
   MIT.

## Consequences

- **The project is no longer open source** in the OSI sense, and must not be
  described as such. "Source-available" is the accurate term. The roadmap,
  marketing copy and package metadata must not claim otherwise.
- **Existing MIT grants survive for copies already obtained.** A license change
  cannot reach back and withdraw permissions already exercised or granted for
  prior commits and releases. What applies to a given version therefore depends
  on when it was obtained — an unresolved question, recorded rather than
  resolved in `NOTICE`.
- **Contribution friction increases.** Contributors must accept the terms in
  `LICENSE` section 8, which include a license back to the Copyright Holder
  broad enough to relicense the project later. Some contributors will decline
  that; that is a consequence of the policy, not a defect in the draft.
- **Commercial enquiries need a real channel.** `LICENSE` section 5 points to
  the repository owner account. A written permission process (scope, term,
  fee, attribution) does not exist yet and is a follow-up deliverable.
- **The draft is not a control.** Nothing here prevents copying, and a draft
  that is never reviewed provides weaker protection than a reviewed final
  license. Legal review is the next step, not an optional one.
- **No code impact.** No source file, test, build step, CLI behavior, storage
  format or execution capability is touched by this ADR.

## Alternatives considered

- **Keep MIT and rely on a policy document.** Rejected: an explicit MIT grant
  overrides an informal policy, and the contradiction is exactly what this
  change exists to remove.
- **Business Source License (BUSL) or PolyForm Noncommercial.** Not adopted:
  both are written for a defined change date or a specific licensor structure,
  and neither matches the intended combination of allowed personal
  modification, permissioned commercial use and a reserved brand. They remain
  reasonable inputs to legal review.
- **A proprietary, all-rights-reserved license.** Rejected: it would forbid the
  educational and personal use the owner intends to allow, and would make the
  source-available publication pointless.
- **Add a `LICENSE` draft but leave `package.json` and the README alone.**
  Rejected: it leaves machine-readable and human-readable MIT grants in place,
  which is the contradiction this ADR is meant to remove.
- **Rewrite or delete ADR-0001.** Rejected: accepted ADRs are immutable in this
  repository; the record is superseded, not edited away.
- **Claim the draft is a final, enforceable license.** Rejected as dishonest;
  the documents must state exactly what has not been reviewed.
