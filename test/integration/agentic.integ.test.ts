/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 */

/**
 * Agentic Layer — "be called"
 * ===========================
 * Business scenario: a traveler tells their AI assistant,
 *   "Find me a pet-friendly hotel in Denver this weekend for under $200 and book it."
 * An agent fulfils that by calling the Octank Hospitality API as a sequence of
 * tools. These tests walk that exact journey against the live API:
 *
 *   1. searchProperties(city=denver, pets=true, maxRate=200)  -> pick a property
 *   2. getAvailability(propertyId)                            -> are rooms open?
 *   3. getRates(propertyId)                                   -> what will it cost?
 *   4. createReservation(...)                                 -> book it (idempotent)
 *
 * They also assert the agent-reliability properties the blog calls out:
 * idempotency, typed/validated inputs, and clear structured errors.
 *
 * API base resolves from API_URL (direct) or BLOG_URL + /api (via CloudFront).
 * Through CloudFront the path is `/api/<resource>`; the direct URL already
 * includes the stage. Self-skips when neither env var is set.
 */

import {
  describeIfDeployed,
  apiBase,
  getJson,
  postJson,
} from './helpers.js';

interface Property {
  property_id: number;
  property_name: string;
  city_name: string;
  pets_allowed: boolean;
  star_rating: string;
}
interface PropertyList {
  count: number;
  properties: Property[];
}
interface Availability {
  property_id: string;
  availability?: Array<{ avail_date: string; room_type: string; rooms_available: number }>;
  error?: string;
}
interface Rates {
  property_id: string;
  rates: Array<{ rate_date: string; room_type: string; nightly_rate_usd: string | number }>;
}
interface Reservation {
  status: string;
  confirmation_number: string;
  details: Record<string, unknown>;
}
interface ApiError {
  error: string;
  message: string;
  suggestion?: string;
}

// `apiBase()` is only called inside tests, which are themselves gated by
// describeIfDeployed, so this never throws at import time.
const requires = apiBase() ? [] : ['BLOG_URL'];

describeIfDeployed(requires)('Agentic layer — the Octank traveler journey', () => {
  const base = apiBase()!;

  // Carries the chosen property through the journey (search -> availability -> rates).
  let chosen: Property | undefined;

  describe('step 1 — searchProperties: "pet-friendly hotel in Denver under $200"', () => {
    it('returns structured JSON matching the documented schema', async () => {
      const { status, body } = await getJson<PropertyList>(
        `${base}/properties?city=denver&pets=true&maxRate=200`,
      );
      expect(status).toBe(200);
      expect(typeof body.count).toBe('number');
      expect(Array.isArray(body.properties)).toBe(true);
      expect(body.count).toBe(body.properties.length);
      expect(body.count).toBeGreaterThan(0);

      const p = body.properties[0];
      // Clear field names an agent can parse directly (not HTML fragments).
      expect(p).toHaveProperty('property_id');
      expect(p).toHaveProperty('property_name');
      expect(p).toHaveProperty('city_name');
      expect(p).toHaveProperty('pets_allowed');

      chosen = body.properties[0];
    });

    it('honors the filters (every result is a pet-friendly Denver property)', async () => {
      const { body } = await getJson<PropertyList>(
        `${base}/properties?city=denver&pets=true&maxRate=200`,
      );
      for (const p of body.properties) {
        expect(p.city_name.toLowerCase()).toBe('denver');
        expect(p.pets_allowed).toBe(true);
      }
    });

    it('is sorted by star rating descending (best options first)', async () => {
      const { body } = await getJson<PropertyList>(`${base}/properties?city=denver`);
      const ratings = body.properties.map((p) => Number(p.star_rating));
      const sorted = [...ratings].sort((a, b) => b - a);
      expect(ratings).toEqual(sorted);
    });
  });

  describe('step 2 — getAvailability for the chosen property', () => {
    it('returns structured availability (or a typed no_availability signal), not HTML', async () => {
      const propertyId = chosen?.property_id ?? 1;
      const { status, body } = await getJson<Availability>(
        `${base}/properties/${propertyId}/availability?checkIn=2026-08-22&checkOut=2026-08-24`,
      );
      // The deployed handler returns 200 even when empty, with a structured
      // {error:"no_availability", suggestion} body — assert the real contract.
      expect(status).toBe(200);
      expect(body).toEqual(
        expect.objectContaining(
          body.error
            ? { error: 'no_availability', message: expect.any(String) }
            : { property_id: expect.anything(), availability: expect.any(Array) },
        ),
      );
    });
  });

  describe('step 3 — getRates for the chosen property', () => {
    it('returns nightly rates by room type as structured JSON', async () => {
      const propertyId = chosen?.property_id ?? 1;
      const { status, body } = await getJson<Rates>(
        `${base}/properties/${propertyId}/rates`,
      );
      expect(status).toBe(200);
      expect(body.property_id).toBeDefined();
      expect(Array.isArray(body.rates)).toBe(true);
      if (body.rates.length > 0) {
        expect(body.rates[0]).toHaveProperty('room_type');
        expect(body.rates[0]).toHaveProperty('nightly_rate_usd');
      }
    });
  });

  describe('step 4 — createReservation (only after the traveler confirms)', () => {
    const booking = {
      property_id: 1,
      room_type: 'king',
      check_in: '2026-08-22',
      check_out: '2026-08-24',
      guest_name: 'Alex Traveler',
    };

    it('confirms a booking and returns a confirmation number', async () => {
      const { status, body } = await postJson<Reservation>(
        `${base}/reservations`,
        booking,
      );
      expect(status).toBe(201);
      expect(body.status).toBe('confirmed');
      expect(body.confirmation_number).toMatch(/^GEO-\d{7}$/);
    });

    it('is idempotent — the same request yields the same confirmation number', async () => {
      // The blog highlights idempotency because agents retry. (In the sample
      // handler this is a deterministic hash of the payload, not a DB upsert —
      // the externally observable contract is identical: same in, same out.)
      const first = await postJson<Reservation>(`${base}/reservations`, booking);
      const second = await postJson<Reservation>(`${base}/reservations`, booking);
      expect(first.body.confirmation_number).toBe(second.body.confirmation_number);
    });
  });

  describe('agent-reliability properties the blog calls out', () => {
    it('typed inputs: a string path param resolves against the integer id column', async () => {
      // The agent passes propertyId as a string "1"; the data layer casts it
      // (:pid::int) so it matches integer row 1 — the blog's typed-input point.
      const { status, body } = await getJson<Rates>(`${base}/properties/1/rates`);
      expect(status).toBe(200);
      expect(String(body.property_id)).toBe('1');
    });

    it('returns clear, structured errors an agent can self-correct on', async () => {
      // Missing required fields -> {error, message, suggestion}, HTTP 400.
      const { status, body } = await postJson<ApiError>(`${base}/reservations`, {
        property_id: 1,
      });
      expect(status).toBe(400);
      expect(body).toMatchObject({
        error: 'missing_fields',
        message: expect.any(String),
      });
      expect(body.suggestion).toBeTruthy();
    });

    it('rejects unknown routes at the gateway level (no catch-all proxy)', async () => {
      // The API Gateway defines specific resources (not a {proxy+} catch-all),
      // so unregistered paths are rejected by the gateway before reaching the
      // Lambda. Through CloudFront this appears as a 403 from the API origin.
      const { status } = await getJson<unknown>(`${base}/properties/999/unknown`);
      expect(status).toBe(403);
    });
  });
});
