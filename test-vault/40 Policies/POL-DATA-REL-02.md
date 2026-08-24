---
type: policy
id: POL-DATA-REL-02
title: Release of clinical data to external collaborators
authority: "[[Invented Data Governance Office]]"
scope: institutional
status: current
version: "3"
effective: 2025-09-01
review_due: 2026-06-30
governs:
  - { what: gate, ref: "edata-request:extraction", clause: "5.2",
      note: "The DUA gate refuses an identifiable extraction without one." }
  - { what: form, ref: "[[FORM-consent-baseline]]",
      note: "No clause recorded, so a revision can only ever report this as review." }
---

# 1 Purpose

This document is entirely invented. It exists so the policy register, the
revision freeze and the impact map have something to work against, and it
describes no real institution's rules.

It states the conditions under which clinical data held by the facility may be
released to a collaborator outside the institution.

# 2 Scope

Applies to every release of record-level data, whether by extract, secure
transfer or direct access to an analysis environment. Aggregate summaries
published in a manuscript are out of scope.

# 5 Conditions of release

## 5.1 Internal use

Data may be used inside the institution for the purpose approved by the ethics
committee without further authorisation, provided the analyst is named on the
approved study team.

## 5.2 Onward transfer

Record-level data may not leave the institution without a data use agreement
signed by the receiving institution.

## 5.3 De-identification

Direct identifiers are removed before release. Indirect identifiers may be
retained only where the approved protocol requires them and the data use
agreement names them explicitly.

## 5.4 Retention of extracts

An extract released under this policy is destroyed by the receiving institution
within twelve months of the end of the approved study period, and the facility
records the destruction confirmation against the request.
