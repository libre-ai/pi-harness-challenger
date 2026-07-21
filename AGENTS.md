# Règles du package challenger

- Le package complète le harness Pi ; il ne remplace pas les ressources globales existantes.
- Ne jamais installer ou activer globalement ce package sans demande explicite.
- `policy-gate` reste en mode `observe` par défaut tant que le corpus A n’est pas validé.
- Une règle de prompt n’est pas une frontière de sécurité ; documenter les limites du shell et recommander un sandbox pour l’isolation forte.
- Ne persister ni commandes, ni chemins bruts, ni contenus d’outils, ni secrets, ni données personnelles.
- Toute nouvelle dépendance exige une justification, un audit de licence et un audit des flux de données.
- Préférer les modules purs testables et les API Node/Pi existantes.
- Après changement, exécuter `npm run check`.
