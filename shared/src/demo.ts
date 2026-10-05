/** IDs fijos del seed: permiten firmar JWTs de prueba sin IdP. */
export const DEMO = {
  tenants: {
    acme: { id: "11111111-1111-4111-8111-111111111111", name: "Acme Corp" },
    globex: { id: "22222222-2222-4222-8222-222222222222", name: "Globex" },
  },
  ambassadors: {
    ana: { id: "a0000000-0000-4000-8000-000000000001", tenant: "acme", name: "Ana (token válido)", token: "valid" },
    bruno: { id: "a0000000-0000-4000-8000-000000000002", tenant: "acme", name: "Bruno (token expirado)", token: "expired" },
    carla: { id: "a0000000-0000-4000-8000-000000000003", tenant: "acme", name: "Carla (token revocado)", token: "revoked" },
    diego: { id: "a0000000-0000-4000-8000-000000000004", tenant: "globex", name: "Diego (token válido)", token: "valid" },
    elena: { id: "a0000000-0000-4000-8000-000000000005", tenant: "globex", name: "Elena (token válido)", token: "valid" },
  },
} as const;

export type DemoAmbassadorKey = keyof typeof DEMO.ambassadors;
