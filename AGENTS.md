# Règles du package challenger

## Authority

Package Pi transitoire de la couche transverse (outillage d'agent) : expériences additives et réversibles pour un harness Pi local. Son extraction vers la flotte puis sa suppression sont décidées à part ; ne pas investir au-delà de la conformité.
Doctrine en amont : https://raw.githubusercontent.com/libre-ai/project-governance/migrate/recover-code/docs/README.md

## Boundaries

- Le package complète le harness Pi ; il ne remplace pas les ressources globales existantes.
- Ne jamais installer ou activer globalement ce package sans demande explicite.
- Ne persister ni commandes, ni chemins bruts, ni contenus d’outils, ni secrets, ni données personnelles.
- Toute nouvelle dépendance exige une justification, un audit de licence et un audit des flux de données.

## Quality gates

Après changement, exécuter `npm run check`. Ne jamais masquer un test rouge.

## Agents

- `policy-gate` reste en mode `observe` par défaut tant que le corpus A n’est pas validé.
- Une règle de prompt n’est pas une frontière de sécurité ; documenter les limites du shell et recommander un sandbox pour l’isolation forte.
- Préférer les modules purs testables et les API Node/Pi existantes.
