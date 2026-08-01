// Percentage Report: totals + percentages computed from the current job's rows.
//
// Every percentage shows its supporting count and its denominator. Division is
// always safe: a zero denominator yields 0.00 (never NaN / Infinity / blank).
// This is the single source of truth used by the /api/percentage endpoint, the
// XLSX/CSV/PDF downloads, and (indirectly, via that endpoint) the live tab.

import { DISPOSITION } from "../automation/constants.js";
import { categorizeRow, TAB } from "../data/store.js";

const norm = (s) => String(s || "").trim().toLowerCase();

/** Safe percentage: 0.00 when denominator is 0. Returns a Number (2 dp). */
export function pct(num, den) {
  if (!den || den <= 0) return 0;
  const v = (Number(num || 0) / Number(den)) * 100;
  if (!Number.isFinite(v)) return 0;
  return Number(v.toFixed(2));
}
/** "12.34%" string form. */
export function pctStr(num, den) {
  return pct(num, den).toFixed(2) + "%";
}

// A lead counts as "texted" if we recorded a send (timestamp or saved body or
// the Text Sent disposition), regardless of any later re-categorization.
function isTextSent(r) {
  return !!(r.textSentTimestamp || r.sentMessageBody || r.disposition === DISPOSITION.TEXT_SENT);
}
// A lead is "processed" once it has been worked (any disposition but Pending).
function isProcessed(r) {
  return r.disposition && r.disposition !== DISPOSITION.PENDING;
}

/** Apply the report filters to the rows. Empty/absent filters match everything. */
export function applyFilters(rows, filters = {}) {
  const f = filters || {};
  const company = norm(f.company);
  const state = norm(f.state);
  const delivery = norm(f.deliveryStatus);
  const reply = norm(f.replyClassification);
  const source = norm(f.leadSource);
  const sentDate = String(f.sentDate || "").slice(0, 10);
  const recheckDate = String(f.recheckDate || "").slice(0, 10);
  const dayOf = (iso) => { try { return new Date(iso).toISOString().slice(0, 10); } catch { return ""; } };
  return rows.filter((r) => {
    if (company && norm(r.companySource) !== company) return false;
    if (state && norm(r.state) !== state) return false;
    if (delivery && norm(r.messageDeliveryStatus) !== delivery) return false;
    if (reply && norm(r.replyClassification) !== reply) return false;
    if (source && norm(r.companySource) !== source) return false;
    if (sentDate && dayOf(r.textSentTimestamp) !== sentDate) return false;
    if (recheckDate && dayOf(r.messageStatusLastCheckedAt) !== recheckDate) return false;
    return true;
  });
}

/**
 * Compute the full percentage report for a set of rows.
 * @returns {{generatedAt, totals, rates, replyRates, leadRates, activeDeal,
 *            recheck, denominators}}
 */
export function computePercentageReport(rows, filters = {}) {
  const R = applyFilters(rows || [], filters);

  const totalLeads = R.length;
  const totalProcessed = R.filter(isProcessed).length;
  const texted = R.filter(isTextSent);
  const totalTextsSent = texted.length;

  // Delivery buckets (from messageDeliveryStatus, set at send + refined by recheck).
  let delivered = 0, failed = 0, undelivered = 0, sentOnly = 0, unknown = 0;
  for (const r of texted) {
    switch (norm(r.messageDeliveryStatus)) {
      case "delivered": delivered++; break;
      case "failed": failed++; break;
      case "undelivered": undelivered++; break;
      case "sent": sentOnly++; break;
      default: unknown++; // Unknown / Needs Recheck / blank
    }
  }
  const confirmedSent = sentOnly + delivered; // message visibly present in REI

  // Replies (each lead counted once). Reply-classification counts are gated on
  // an ACTUAL reply, so "Among Replies" percentages can never exceed 100%.
  const repliedLeads = texted.filter((r) => r.replyReceived);
  const totalReplies = repliedLeads.length;
  // Count reply categories over the SAME set as the denominator (repliedLeads),
  // so "Among Replies" percentages can never exceed 100%.
  const interested = repliedLeads.filter((r) => norm(r.replyClassification) === "interested").length;
  const notInterestedReplies = repliedLeads.filter((r) => norm(r.replyClassification) === "not_interested").length;
  const needsReviewReplies = repliedLeads.filter((r) => norm(r.replyClassification) === "needs_review").length;
  const noReply = Math.max(0, totalTextsSent - totalReplies);

  // Lead-result buckets (by tab categorization).
  const cat = (t) => R.filter((r) => categorizeRow(r) === t).length;
  const propertySold = cat(TAB.PROPERTY_SOLD);
  const badLeads = cat(TAB.BAD_LEADS);
  const outOfState = cat(TAB.OUT_OF_STATE);
  const activeDeals = cat(TAB.ACTIVE_DEAL);
  const notInterestedTab = cat(TAB.NOT_INTERESTED);
  const needsReviewTab = cat(TAB.NEEDS_REVIEW);

  const recheckedCount = texted.filter((r) => r.recheckCompleted).length;

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      totalLeads, totalProcessed, totalTextsSent, confirmedSent,
      delivered, failed, undelivered, unknownStatus: unknown,
      totalReplies, interested, notInterested: notInterestedReplies,
      needsReview: needsReviewReplies, noReply,
      propertySold, badLeads, outOfState, activeDeals,
      notInterestedTab, needsReviewTab,
    },
    // Rates over Total Texts Sent (delivery + reply).
    rates: {
      confirmedSentRate: pct(confirmedSent, totalTextsSent),
      deliveryRate: pct(delivered, totalTextsSent),
      failedRate: pct(failed, totalTextsSent),
      undeliveredRate: pct(undelivered, totalTextsSent),
      unknownStatusRate: pct(unknown, totalTextsSent),
      overallReplyRate: pct(totalReplies, totalTextsSent),
      noReplyRate: pct(noReply, totalTextsSent),
      interestedSellerRate: pct(interested, totalTextsSent),
      notInterestedRate: pct(notInterestedReplies, totalTextsSent),
      needsReviewRate: pct(needsReviewReplies, totalTextsSent),
    },
    // Percentages based on Total Replies (kept separate + clearly labeled).
    replyRates: {
      interestedAmongReplies: pct(interested, totalReplies),
      notInterestedAmongReplies: pct(notInterestedReplies, totalReplies),
      needsReviewAmongReplies: pct(needsReviewReplies, totalReplies),
    },
    // Lead-result percentages over Total Leads Processed.
    leadRates: {
      textSentPct: pct(totalTextsSent, totalProcessed),
      propertySoldPct: pct(propertySold, totalProcessed),
      badLeadPct: pct(badLeads, totalProcessed),
      outOfStatePct: pct(outOfState, totalProcessed),
      activeDealPct: pct(activeDeals, totalProcessed),
      notInterestedToDeletePct: pct(notInterestedTab, totalProcessed),
    },
    // Active-deal conversion.
    activeDeal: {
      fromTextsSent: pct(activeDeals, totalTextsSent),
      fromReplies: pct(activeDeals, totalReplies),
      interestedToActiveDeal: pct(activeDeals, interested),
    },
    recheck: {
      recheckedCount,
      recheckCompletePct: pct(recheckedCount, totalTextsSent),
    },
    // The denominators behind each formula (for the download / transparency).
    denominators: {
      totalLeads, totalProcessed, totalTextsSent, totalReplies, interested,
    },
  };
}

/** Flat [{Metric, Total, Percentage, "Percentage Based On"}] rows for XLSX/CSV. */
export function reportTableRows(rep) {
  const t = rep.totals, r = rep.rates, rr = rep.replyRates, lr = rep.leadRates, ad = rep.activeDeal;
  const p = (v) => v.toFixed(2) + "%";
  return [
    { Metric: "Total Leads", Total: t.totalLeads, Percentage: "", "Percentage Based On": "" },
    { Metric: "Total Leads Processed", Total: t.totalProcessed, Percentage: "", "Percentage Based On": "" },
    { Metric: "Texts Sent", Total: t.totalTextsSent, Percentage: p(lr.textSentPct), "Percentage Based On": "Leads Processed" },
    { Metric: "Confirmed Sent", Total: t.confirmedSent, Percentage: p(r.confirmedSentRate), "Percentage Based On": "Texts Sent" },
    { Metric: "Delivered", Total: t.delivered, Percentage: p(r.deliveryRate), "Percentage Based On": "Texts Sent" },
    { Metric: "Failed", Total: t.failed, Percentage: p(r.failedRate), "Percentage Based On": "Texts Sent" },
    { Metric: "Undelivered", Total: t.undelivered, Percentage: p(r.undeliveredRate), "Percentage Based On": "Texts Sent" },
    { Metric: "Unknown Status", Total: t.unknownStatus, Percentage: p(r.unknownStatusRate), "Percentage Based On": "Texts Sent" },
    { Metric: "Total Replies", Total: t.totalReplies, Percentage: p(r.overallReplyRate), "Percentage Based On": "Texts Sent" },
    { Metric: "No Reply", Total: t.noReply, Percentage: p(r.noReplyRate), "Percentage Based On": "Texts Sent" },
    { Metric: "Interested in Selling", Total: t.interested, Percentage: p(r.interestedSellerRate), "Percentage Based On": "Texts Sent" },
    { Metric: "Interested Among Replies", Total: t.interested, Percentage: p(rr.interestedAmongReplies), "Percentage Based On": "Total Replies" },
    { Metric: "Not Interested", Total: t.notInterested, Percentage: p(r.notInterestedRate), "Percentage Based On": "Texts Sent" },
    { Metric: "Not Interested Among Replies", Total: t.notInterested, Percentage: p(rr.notInterestedAmongReplies), "Percentage Based On": "Total Replies" },
    { Metric: "Needs Review", Total: t.needsReview, Percentage: p(r.needsReviewRate), "Percentage Based On": "Texts Sent" },
    { Metric: "Needs Review Among Replies", Total: t.needsReview, Percentage: p(rr.needsReviewAmongReplies), "Percentage Based On": "Total Replies" },
    { Metric: "Property Sold", Total: t.propertySold, Percentage: p(lr.propertySoldPct), "Percentage Based On": "Leads Processed" },
    { Metric: "Bad Leads", Total: t.badLeads, Percentage: p(lr.badLeadPct), "Percentage Based On": "Leads Processed" },
    { Metric: "Out of State", Total: t.outOfState, Percentage: p(lr.outOfStatePct), "Percentage Based On": "Leads Processed" },
    { Metric: "Active Deals", Total: t.activeDeals, Percentage: p(lr.activeDealPct), "Percentage Based On": "Leads Processed" },
    { Metric: "Active Deals (of Texts Sent)", Total: t.activeDeals, Percentage: p(ad.fromTextsSent), "Percentage Based On": "Texts Sent" },
    { Metric: "Active Deals (of Replies)", Total: t.activeDeals, Percentage: p(ad.fromReplies), "Percentage Based On": "Total Replies" },
    { Metric: "Interested → Active Deal", Total: t.activeDeals, Percentage: p(ad.interestedToActiveDeal), "Percentage Based On": "Interested in Selling" },
  ];
}
