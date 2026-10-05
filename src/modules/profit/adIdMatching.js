'use strict';

const { touchSql } = require('../analytics/orderTouch');

/**
 * Orders matched to ad spend by the ad's id (SPEC §15.4: "utm_campaign =
 * campaign name or ID, or ad_id from the URL parameters").
 *
 * The suggested URL parameters put `ad_id={{ad.id}}` on every ad's link; the
 * storefront keeps it in the order's touch (`adId`, analytics/orderTouch).
 * Spend learns which ads belong to a campaign from an ads-manager export at
 * ad level — a CSV with an "Ad ID" column: its rows are added up per day and
 * campaign, and the ids kept on the day's row (ad_spend_daily.ad_ids). An
 * order whose campaign matches no spend (a renamed campaign, a missing or
 * templated utm_campaign) is then counted under the campaign its ad belongs to.
 */

const AD_ID_HEADERS = ['ad id', 'ad_id', 'adid', 'معرف الإعلان'];

const adKey = (id) => String(id || '').trim().toLowerCase();

/** SQL: the ad id of the order's touch, lower-cased ('' when it has none). */
function adIdSql(which = 'last') {
  const touch = touchSql(which);
  return `coalesce(lower(nullif(${touch}->>'adId', '')), '')`;
}

/**
 * Ad-level CSV rows → one row per (day, platform, campaign), spend and counts
 * added up, the ad ids collected. Rows without an ad id pass through as they are.
 */
function foldAdRows(rows) {
  const out = new Map();
  for (const row of rows) {
    const key = `${row.day}|${row.platform}|${row.campaignName.trim().toLowerCase()}`;
    const ad = adKey(row.adId);
    const seen = out.get(key);
    if (!seen) {
      const { adId, ...rest } = row;
      out.set(key, { ...rest, adIds: ad ? [ad] : [] });
      continue;
    }
    seen.spendAmount += row.spendAmount;
    if (row.impressions !== null) seen.impressions = (seen.impressions || 0) + row.impressions;
    if (row.clicks !== null) seen.clicks = (seen.clicks || 0) + row.clicks;
    if (!seen.campaignId && row.campaignId) seen.campaignId = row.campaignId;
    if (ad && !seen.adIds.includes(ad)) seen.adIds.push(ad);
  }
  return [...out.values()];
}

/** SQL: every (campaign_key, ad_id) the store's spend knows, whatever the day. */
const AD_LINKS_SQL = `SELECT DISTINCT campaign_key, lower(a.ad_id) AS ad_id
    FROM ad_spend_daily, jsonb_array_elements_text(ad_ids) AS a(ad_id)
   WHERE workspace_id = :workspaceId AND ad_ids IS NOT NULL`;

/**
 * Folds order groups — { campaign, ad_id, …counts } from the campaigns query —
 * onto the spend rows' keys: by campaign name or id first, then by ad id
 * (`adLinks`, from AD_LINKS_SQL). Returns the groups re-keyed (`campaign` =
 * the spend row's key where one was found) and summed.
 */
function foldOrders(orderGroups, spendRows, adLinks, countFields) {
  const keys = new Set(spendRows.map((s) => s.campaign_key));
  const byId = new Map(spendRows.filter((s) => s.campaign_id).map((s) => [s.campaign_id, s.campaign_key]));
  const byAd = new Map(adLinks.map((l) => [adKey(l.ad_id), l.campaign_key]));
  const out = new Map();
  for (const group of orderGroups) {
    const campaign = group.campaign || '';
    const ad = group.ad_id || '';
    const key = (keys.has(campaign) && campaign) || byId.get(campaign) || (ad && byAd.get(ad)) || campaign || (ad ? `ad ${ad}` : '');
    if (!key) continue;
    const sum = out.get(key) || { campaign: key };
    for (const field of countFields) sum[field] = Number(sum[field] || 0) + Number(group[field] || 0);
    out.set(key, sum);
  }
  return [...out.values()];
}

module.exports = { AD_ID_HEADERS, AD_LINKS_SQL, adIdSql, foldAdRows, foldOrders, adKey };
