// Configuration centralisée de l'identité de marque.
// Un seul endroit à modifier si le nom, le domaine ou l'email de support changent.
export const appConfig = {
  appName: "ADMEMRIZE",
  appTagline: "Capturez. Scellez. Révélez ensemble.",
  appDomain: process.env.APP_DOMAIN ?? "http://localhost:5173",
  supportEmail: process.env.SUPPORT_EMAIL ?? "support@example.com",
} as const;
