/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Foundation Layer — "be cited"
 * =============================
 * Business scenario: before an AI assistant can recommend Octank Hospitality to
 * a traveler, it must be able to crawl, parse, and understand the site. These
 * tests assert the foundation that gets Octank into AI answers:
 *   - server-rendered content served over HTTPS with security headers
 *   - robots.txt that explicitly allows AI crawlers (GPTBot, ClaudeBot, ...)
 *   - llms.txt content map served from the site root
 *   - sitemap.xml that resolves
 *   - LodgingBusiness schema.org JSON-LD embedded in each property page's <head>
 *
 * Requires: BLOG_URL (CloudFront distribution domain). Self-skips otherwise.
 */

import { describeIfDeployed, optionalEnv, trimSlash, getText, extractJsonLd } from './helpers.js';

const AI_CRAWLERS = ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended', 'Amazonbot'];

// A real property from the Octank directory (Denver — the scenario's city).
const SCENARIO_PROPERTY = 'octank-hotels-denver-downtown';

describeIfDeployed(['BLOG_URL'])('Foundation layer — be cited', () => {
  // trimSlash is null-safe; when BLOG_URL is unset this block is skipped, but
  // its body is still evaluated by Jest, so base resolves to '' without throwing.
  const base = trimSlash(optionalEnv('BLOG_URL'));

  describe('content is served (crawlable, low-latency origin)', () => {
    it('serves the SPA root over HTTPS as HTML', async () => {
      const { status, headers } = await getText(`${base}/`);
      expect(status).toBeLessThan(400);
      expect(headers.get('content-type')).toMatch(/text\/html/);
    });

    it('applies security headers from the CloudFront response policy', async () => {
      const { headers } = await getText(`${base}/`);
      // The blog's edge layer attaches a security-headers response policy.
      expect(headers.get('strict-transport-security')).toBeTruthy();
      expect(headers.get('x-content-type-options')).toBe('nosniff');
      expect(headers.get('x-frame-options')).toBeTruthy();
    });
  });

  describe('discoverability assets make intent explicit', () => {
    it('serves robots.txt that allows the major AI crawlers', async () => {
      const { status, text } = await getText(`${base}/robots.txt`);
      expect(status).toBe(200);
      // "Unblocking AI crawlers is often the single highest-impact change."
      for (const bot of AI_CRAWLERS) {
        expect(text).toContain(bot);
      }
    });

    it('serves llms.txt as a plain-text content map listing properties', async () => {
      const { status, headers, text } = await getText(`${base}/llms.txt`);
      expect(status).toBe(200);
      expect(headers.get('content-type')).toMatch(/text\/plain/);
      // The content map should reference Octank and the scenario property.
      expect(text).toMatch(/Octank/i);
      expect(text).toContain(SCENARIO_PROPERTY);
    });

    it('serves a sitemap.xml that resolves', async () => {
      const { status, text } = await getText(`${base}/sitemap.xml`);
      expect(status).toBe(200);
      expect(text).toMatch(/<urlset|<sitemapindex/);
    });
  });

  describe('structured data (schema.org JSON-LD) is embedded in the page', () => {
    it('embeds a LodgingBusiness block in the property page <head> (single fetch, no JS render)', async () => {
      const { status, text } = await getText(
        `${base}/properties/${SCENARIO_PROPERTY}.html`,
      );
      expect(status).toBe(200);

      const ld = extractJsonLd(text);
      expect(ld).toBeDefined();
      expect(ld!['@context']).toBe('https://schema.org');
      expect(ld!['@type']).toBe('LodgingBusiness');
      expect(ld!['name']).toMatch(/Octank/);
    });

    it('exposes the attributes an AI needs to cite the property (geo, rating, amenities)', async () => {
      const { text } = await getText(`${base}/properties/${SCENARIO_PROPERTY}.html`);
      const ld = extractJsonLd(text)!;

      // Geo-coordinates — "pet-friendly hotel in Denver" needs a locatable entity.
      expect(ld['address']).toMatchObject({ addressLocality: 'Denver', addressRegion: 'CO' });
      expect(ld['geo']).toHaveProperty('latitude');

      // Rating drives "best" / recommendation queries.
      expect(ld['aggregateRating']).toHaveProperty('ratingValue');

      // Amenities are what the agent matches against ("pool", "pet-friendly").
      expect(Array.isArray(ld['amenityFeature'])).toBe(true);
    });
  });
});
