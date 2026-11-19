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
legal review and the governing law is not chosen. The copyright holder line is
being restated as the person's name, the owner having confirmed that the GitHub
handle "Zakariaika" and Taqiyeddin Maatlia are the same person, so no separate
author and no transfer of copyright is involved. A final license cannot honestly
be claimed yet, and the documents must not pretend otherwise.

## Decision

1. **Replace the MIT license text with a clearly labelled draft** of a
   source-available, non-commercial license in `LICENSE`, versioned `0.4-draft`.
   The draft states that it has not been legally reviewed and is not a claim of
   enforceability, in its own first section rather than in a footnote.

2. **Grant non-commercial permission and reserve everything else.** Personal,
   educational and other non-commercial use, non-commercial modification,
   non-commercial redistribution of unmodified copies, non-commercial
   distribution of modified versions that meet the conditions in `LICENSE` 4.2,
   and non-commercial contributions are permitted. Commercial use (including
   purely internal business use), selling, sublicensing and commercial
   distribution — of the Software or of any modified version — require prior
   written permission.

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
   MIT for future distributions.

8. **Make redistribution a direct grant, not a sublicense.** Passing on an
   unmodified copy, or distributing a modified version that meets `LICENSE` 4.2,
   is permitted free of charge; the recipient receives their own non-commercial
   permission from the Copyright Holder under `LICENSE` 4.1, and the
   redistributor grants nothing in the Software and adds no terms to it.
   Non-transferability and non-sublicensability therefore do not conflict with
   4.1(c) or 4.2: the copy is passed on, the permission is not moved (`LICENSE`
   4.4). A modified version's own original additions remain the modifier's to
   license, and no redistribution grants a recipient a commercial right
   (`LICENSE` 4.5).

9. **State the contribution grant precisely, and record consent explicitly.**
   Contributors keep copyright; the license back is a perpetual, irrevocable,
   transferable, sublicensable right to reproduce, modify, distribute and
   relicense the contribution as part of the Software, including under
   commercial terms. It is a license, not an assignment, and no ownership of a
   contribution is claimed (`LICENSE` 8). Consent is not inferred from the act
   of submitting: a contribution is accepted only after the contributor posts
   the signed statement specified in `CONTRIBUTING.md`, which identifies them
   and the date and is kept with the contribution's history, and a maintainer
   must not merge without it (`LICENSE` 8.1, 8.10; `.github/pull_request_template.md`
   prompts for it). The procedure is described as a documented consent
   mechanism, never as legally sufficient (`LICENSE` 8.11).

10. **Permit non-commercial distribution of modified versions, under named
    conditions.** `LICENSE` 4.2 allows a modified version to be distributed
    non-commercially only if it uses a different name, uses none of the official
    identity, states that it is modified, unofficial and unaffiliated, preserves
    every copyright, license and third-party notice, implies no endorsement, and
    ships the license texts for recipients; the distribution must be free of
    charge and unmonetised. This replaces the earlier draft's requirement of
    written permission for every distribution of a modified version, and it
    keeps commercial distribution behind `LICENSE` 5. `LICENSE` 4.3 and 4.5 are
    worded so that the new permission cannot be read as a commercial right.

11. **Record the MIT boundary in commit terms, and state what cannot be known.**
    `LICENSE` 3.6 and `NOTICE` 3 now give the verified prior side: MIT applied to
    every commit on `main` from the initial commit `5aee287` (2026-11-14)
    through `1768aad` (2026-11-18), the `LICENSE` blob being unchanged across
    that range, and the repository has no tags and no releases. The new side
    starts at the first commit on `main` whose tree contains these documents,
    whatever its commit message and whether it is a merge, a squash or a direct
    commit. That commit does not exist yet, so its identifier is not asserted;
    it must be recorded when the change lands, and until then nothing on `main`
    is distributed under the draft.
    Copies taken from an unmerged branch are not releases and carry the draft
    text; that label does not by itself decide their legal effect. No historical
    MIT notice is rewritten or removed; `package.json` metadata is not treated as
    a grant.

12. **Keep the commercial relicensing right with the Copyright Holder, and say
    so in every place a recipient could read it the other way.** `LICENSE` 8.5
    now grants recipients only the non-commercial permission in 4.1 in a
    contribution; the rights in 8.4 — including relicensing on commercial or
    other terms — run to the Copyright Holder alone and are not granted to
    recipients, redistributors or downstream fork maintainers. `LICENSE` 4.4
    states the direct-grant construction and its three limits: no commercial
    right downstream, no contributor grant downstream, and no licence in a
    modifier's own original additions. `LICENSE` 4.2 says the same for a fork's
    additions, which stay the modifier's to license and do not become part of the
    Software by being combined with it. The construction is still described as
    the Copyright Holder's intent, not as settled law.

13. **Replace automatic, disproportionate termination with notice and cure, and
    stop inventing a liability cap.** `LICENSE` 11 now terminates only for
    material breach, on written notice, with a 30-day cure period where cure is
    possible; minor, technical and accidental breaches do not terminate the
    licence. The clause that terminated a licence for challenging the Copyright
    Holder's rights is removed, and bringing or defending a claim is expressly
    not a termination event. Post-termination duties are limited to stopping use,
    stopping distribution and deleting copies, preserving copies required by law
    and permissions already granted to compliant recipients, and expressly not
    revoking what law does not allow to be revoked; reinstatement is in writing.
    `LICENSE` 13.2 sets no cap, formula or fixed amount: it records the
    exclusion intended in 13.1, leaves the extent of any liability where
    exclusion is not permitted to applicable law as unresolved, and marks any
    cap or insurance as a question for counsel, because an invented cap can be
    unenforceable or fall below a statutory minimum.

14. **Classify the non-commercial edge cases, and name the ones left open.**
    `LICENSE` 1.3 and 1.4 are rewritten so that classroom teaching and unfunded
    academic research are non-commercial, while an activity that is charged for,
    revenue-generating or commercially sponsored is commercial, and 1.8 lists
    the resolved cases (individual, classroom, unfunded research, evaluation;
    for-profit internal use, employee use, hosted services, commercial
    distribution, paid sponsorship) and the open ones (non-profit internal use,
    government and public-sector use, mixed-funded research, donation-funded
    hosting, donations to contributors). An open case defaults to commercial
    pending written permission and is recorded in `NOTICE` rather than settled
    by guesswork.

15. **State only trademark rights that exist.** `TRADEMARKS.md` separates
    copyright in logo artwork from trademark rights in names and marks, claims no
    registration, stops treating the palette, screenshots, iconography, package
    name and command name as trademarks, and replaces the prohibition on uses
    that "disparage" the project with a restriction on misleading affiliation,
    false endorsement, deceptive naming and confusing presentation. Criticism,
    negative reviews, independent reporting, comparison and educational
    references are expressly permitted.

16. **Make "revocable" mean section 11, and narrow materiality.** `LICENSE` 4.1
    now says the permission is revocable only through the procedure in section
    11, and states that no provision grants a right to withdraw it at will, on
    mere notice or for convenience; the reservation of other rights in 4.3 is
    unchanged. `LICENSE` 11.2 requires a written notice that identifies the
    breach and, where cure is possible, what cure requires; a cure within 30
    days means no termination occurs. Commercial use or distribution without
    permission and presenting an unexecuted run as `PASS` remain material, but a
    failure to keep notices is material only when it defeats the purpose of the
    licence. `LICENSE` 11.3 now says expressly that an accidental or technical
    violation — including an inadvertent notice omission, a metadata error or a
    momentary failure corrected promptly — is not material and does not become
    material unless it continues after written notice. Decision 22 later
    separates a third, stoppable-but-not-undoable class of breach. `LICENSE`
    11.8 also preserves 8.3 and 8.9, and explains that survival preserves terms rather
    than a terminated party's permission, with 11.5 and 11.6 controlling what
    may still be done. No termination right is added outside section 11.

17. **Remove the last trace of an invented liability formula.** `LICENSE` 13.2
    now sets no cap, no formula and no fixed amount, and does not assert that
    any limitation is enforceable. It records the exclusion intended in 13.1,
    leaves the extent of liability where exclusion is not permitted to
    applicable law as unresolved in the draft, and marks any cap or insurance as
    a question for counsel. The earlier "smallest amount applicable law
    permits" wording, which read as a limitation formula, is gone.

18. **Resolve the donation and hosted-service overlap instead of leaving two
    rules.** `LICENSE` 1.4(d) no longer classifies the donation-funded free
    public service that 1.8(m) leaves open. `LICENSE` 1.4(f) now defines when a
    payment or sponsorship is commercial consideration, excludes a personal
    gift to a contributor that 1.8(n) addresses, and leaves a donation funding
    the 1.8(m) service to that paragraph. `LICENSE` 1.8(m) states what it leaves
    open (free access, and no revenue other than donations that are not
    consideration), and 1.8(n) distinguishes a personal donation from support
    connected with the Software or given for influence, access or another
    benefit, which is commercial under 1.4(f).

19. **Take only the rights a contributor actually has, and state which document
    governs what.** `LICENSE` 8.2 now asks for the authority a contributor
    holds, not a claim of personal ownership: third-party material must be
    licensed in a way that permits the 8.4 grant, and an employer, client or
    other organisation that owns the contribution must authorise the submission
    and the grant, or agree separate written terms. `LICENSE` 8.1 records that
    requirement, 8.3 applies the retained-copyright position to that
    organisation, and 8.4 grants only to the extent the contributor holds or is
    authorised to grant the rights. The consent statement in `CONTRIBUTING.md`
    and the pull request template no longer ask a contributor to confirm that
    they retain copyright they may not hold; they ask the contributor to
    identify the rights holder and their authority when they do not. `LICENSE`
    14.4 now states the hierarchy: `LICENSE` governs permissions in the
    Software, `TRADEMARKS.md` governs the Brand and grants no software right,
    and `NOTICE` carries notices and factual disclosures and grants no
    permission; neither can override `LICENSE`.

20. **Distinguish internal review from independent audit, and stop assuming how
    the change lands.** `NOTICE` 6.2 now says expressly that the internal
    security work is produced by the copyright holder or by automated tooling
    acting for the project, not by an external auditor or certification body,
    and that a passing automated check establishes only what it tests. `NOTICE`
    3 no longer assumes the change lands as a merge: the new side begins at the
    first commit on `main` whose tree contains the documents, however it was
    created, and the identifier is recorded when it exists rather than guessed.
    The same correction is made in `LICENSE` 3.6(e) and decision 11.

21. **Separate the three donation cases from the receipt-based rule.**
    `LICENSE` 1.4(f) no longer treats consideration as commercial merely
    because it is received by the person or entity that distributes, operates
    or supports the Software; the test is the benefit given or promised, or a
    tie to commercial operation, distribution, support, access or promotion.
    `LICENSE` 1.8 states the three cases explicitly — an unconditional
    personal gift, a donation that funds the free public service in 1.8(m),
    and a payment, sponsorship or donation tied to commercial operation or a
    benefit — and classifies only the third. Paragraphs (m) and (n) stay open
    for the first two, 1.4(f) cross-refers to them, and no paragraph treats
    every donation a project operator receives as commercial consideration.

22. **Make the ownership wording neutral and give section 11 three breach
    classes.** `LICENSE` 8.3 no longer opens by stating that a contributor
    retains copyright. It records that no ownership is transferred, that
    copyright stays with whoever actually holds it — contributor, employer,
    client or other organisation — and that the project receives only the 8.4
    licence to the extent the grantor holds or is authorised to grant it.
    `NOTICE` 5 is aligned with that wording, and 11.8 explains survival in terms
    of the rights holder rather than the contributor. `LICENSE` 11.2 separates
    a fully curable breach, a breach whose continuing effects can be stopped or
    mitigated although the past cannot be undone, and a genuinely incurable
    breach; the middle class gets the 30-day period instead of immediate
    termination, so the change narrows rather than expands the termination
    right, and 11.3 says a breach does not become material merely because it
    cannot be erased. Whether mitigation amounts to cure, and whether the
    middle class is the right construction, is left to counsel and recorded in
    `NOTICE`.

## Consequences

- **The project is no longer open source** in the OSI sense, and must not be
  described as such. "Source-available" is the accurate term. The roadmap,
  marketing copy and package metadata must not claim otherwise.
- **Earlier MIT grants are not revoked for copies already obtained.** This
  license applies to repository contents from the commit that introduces it. It
  is not retroactive and does not cancel permissions already granted for earlier
  versions or copies (`LICENSE` 3.6, `NOTICE` 3). The prior side is recorded
  exactly (`5aee287` through `1768aad`, no tags, no releases); the first commit
  under this license is the first commit on `main` that contains these
  documents, whatever its commit message, and its identifier can only be
  recorded once that commit exists. What applies to a given copy therefore
  depends on when it was obtained, and a repository mixing both licences is a
  labelling question still open.
- **Contribution friction increases, and consent costs a step.** Contributors
  must accept the terms in `LICENSE` section 8, which license the contribution
  to the Copyright Holder broadly enough to relicense the project commercially,
  while copyright stays with the contributor. They must also record that
  acceptance explicitly, because the project no longer treats a submitted pull
  request as agreement; a contributor who does not post the statement is not
  merged. Some contributors will decline either way; it is a consequence of the
  policy, not a defect in the draft. Jurisdictions with non-waivable moral
  rights, corporate contributors and the sufficiency of the consent record still
  need legal review (recorded as open questions).
- **Non-commercial forks are now permitted, and the controls are names and
  notices.** A fork may be published, renamed and distributed free of charge,
  so `LICENSE` 4.2's conditions and the trademark policy are what keep the
  official product identifiable. Compliance is not technically enforced; the
  open question is whether the conditions are sufficient in practice.
- **Commercial enquiries need a real channel.** `LICENSE` section 5 points to
  the repository owner account. A written permission process (scope, term,
  fee, attribution) does not exist yet and is a follow-up deliverable.
- **Termination and liability now have a defensible shape, not a settled
  substance.** Notice, cure and materiality replace automatic termination, and
  the liability section refuses to invent a cap. Whether those choices are
  enforceable, and what cap or insurance is appropriate, still require counsel.
- **The trademark policy claims less than it did.** It asserts no registration
  and no exclusive right beyond what law provides, and it permits criticism and
  reporting explicitly. That is more accurate but also weaker as an enforcement
  document; registration remains an open question for the owner.
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
- **Forbid all distribution of modified versions.** Rejected by the owner:
  publishing a non-commercial fork is part of the intended permission, and the
  conditions in `LICENSE` 4.2 address renaming, branding and notices without a
  case-by-case permission request.
- **Treat submitting a pull request as implicit consent.** Rejected: it produces
  no record of what a contributor agreed to or when, it depends on a term buried
  in a document the contributor may not have read, and the owner asked for
  documented, affirmative consent instead (`CONTRIBUTING.md`).
- **Rewrite `LICENSE` history so the MIT period disappears.** Rejected: prior
  MIT grants cannot be withdrawn by editing the current file, and the record of
  what was distributed under which terms is the point of `LICENSE` 3.6 and
  `NOTICE` 3.
- **Terminate automatically on any breach, including a challenge to the
  Copyright Holder's rights.** Rejected: it makes an accidental or technical
  slip indistinguishable from a commercial violation, offers no opportunity to
  cure, and turns a legal disagreement into a licensing event. Notice, cure and
  a materiality standard are the proportionate alternative.
- **Set a nominal liability cap, such as the amount paid or a small fixed sum.**
  Rejected: for non-commercial use the amount paid is zero, a fixed sum has no
  legal basis in this draft, and a cap chosen without advice can be
  unenforceable or below a statutory minimum. The section says what it knows and
  marks the rest for counsel.
- **Grant every recipient the same rights as the Copyright Holder, including
  commercial relicensing.** Rejected: it would let any recipient sell or
  sublicense the Software and would undo the commercial protection the model
  exists to preserve. The relicensing right stays with the Copyright Holder
  (`LICENSE` 4.4, 8.4, 8.5).
- **Keep the "disparage" prohibition and treat colours, screenshots and command
  names as trademarks.** Rejected: it would restrict truthful criticism, claim
  rights that are not established, and confuse copyright in assets with
  trademark rights in marks.
