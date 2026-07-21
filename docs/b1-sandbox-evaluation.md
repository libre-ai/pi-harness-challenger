# B1 — évaluation locale des backends de sandbox

Date : 20 juillet 2026. Aucun backend installé ou activé par cette évaluation.

## Exigences non négociables

Un backend B1 doit :

1. échouer fermé si l’isolation ne démarre pas ;
2. refuser le réseau par défaut ;
3. rendre le home et les credentials hôte illisibles ;
4. n’autoriser l’écriture que dans une copie jetable du workspace ;
5. ne pas proposer de flag de désactivation dans un mode restrictif ;
6. exposer une attestation de sandbox consommable par `policy-gate` ;
7. tuer les processus et supprimer le workspace à la fin ;
8. ne jamais journaliser commandes, prompts, chemins bruts ou contenu.

Une regex shell ou un simple changement de `cwd` ne satisfait pas ces exigences.

## Candidats inspectés

| Backend | Licence | Isolation | État local | Verdict |
|---|---|---|---|---|
| `@earendil-works/gondolin` 0.12.0 | Apache-2.0 | micro-VM QEMU locale | QEMU 11.0.2 installé sur accord | **Spike technique validé** |
| `@anthropic-ai/sandbox-runtime` 0.0.26 | Apache-2.0 | `sandbox-exec` macOS ou bubblewrap Linux | `sandbox-exec` présent | **Fallback à réécrire** |
| `sandbox-exec` direct | composant macOS propriétaire | profil OS local | présent | **Non portable, non préféré** |

### Gondolin

Points favorables :

- VM locale et filesystem invité isolé hors montage ;
- outils Pi remplacés via leurs opérations structurées ;
- aucune donnée envoyée à un service distant ;
- licence permissive.

Écarts de l’exemple initial :

- le workspace hôte est monté en écriture directe sous `/workspace` ;
- aucune politique réseau deny-by-default n’est démontrée dans l’exemple inspecté ;
- l’installation système et npm exigerait une décision explicite.

Le spike devra copier une fixture vers un workspace jetable plutôt que monter le projet de travail directement.

### sandbox-runtime

Points favorables :

- backend macOS déjà disponible ;
- wrapper local, licence Apache-2.0 ;
- configuration filesystem/réseau explicite.

Écarts bloquants de l’exemple Pi :

- plusieurs domaines réseau sont autorisés par défaut ;
- `--no-sandbox` désactive volontairement l’isolation ;
- une erreur d’initialisation laisse le bash local actif ;
- le package est maintenu par une entreprise US, même si aucun service distant n’est utilisé.

L’exemple ne doit donc pas être copié tel quel. Un fallback acceptable doit remplacer ces comportements par réseau vide, erreur fatale ou bash bloqué, et aucune désactivation en mode restrictif.

## Souveraineté et conformité

### PASS

- aucun hyperscaler ou stockage distant ;
- deux packages candidats sous Apache-2.0 ;
- aucune donnée personnelle nécessaire ;
- formats et workspaces locaux.

### WARN

- origine US de `sandbox-runtime` ;
- QEMU est un composant système supplémentaire sous GPL, mais resterait un exécutable séparé non lié au package ;
- `tweetnacl@0.14.5` utilise réellement Unlicense via `ssh2 → bcrypt-pbkdf`. L’exception manuelle est approuvée uniquement pour Gondolin 0.12.0 aux empreintes revues ; l’absence de concession de brevets et de fallback explicites reste acceptée comme risque ;
- la composition Pi doit garantir que Gondolin est la première extension enregistrant `bash` — Pi conserve le premier outil homonyme — avant de faire confiance à l’attestation ;
- la commande `bash` native du protocole RPC contourne le hook `user_bash`. Le launcher la refuse avant Pi et la garde installée refuse désormais `pi --mode rpc` direct et l’export public `rpc-entry` ; une exécution absolue d’un autre module interne par le propriétaire du compte reste hors modèle de menace.

### FAIL actuel

- le package challenger complet reste non promouvable tant que policy sans sandbox échoue ;
- exemple `sandbox-runtime` toujours fail-open et réseau permissif.

## Audit de licences transitives

- Gondolin : 15 packages npm. Les trois métadonnées absentes (`buildcheck`, `cpu-features`, `ssh2`) ont été vérifiées MIT dans les tarballs exacts. L’option BSD de `node-forge` est compatible. Aucun AGPL/SSPL/BSL ; `tweetnacl@0.14.5` est accepté par l’exception hash-pinnée explicite et l’audit repasse en échec au moindre changement de version, d’intégrité ou d’empreinte.
- sandbox-runtime : 8 packages npm, tous MIT ou Apache-2.0. Aucun AGPL/SSPL/BSL : audit automatisé vert.

L’audit est rejouable hors réseau avec `npm run eval:sandbox:licenses` et repasse en échec si une version ou licence non acceptée apparaît. Il ne corrige pas leurs écarts d’isolation.

## Spike Gondolin autorisé

QEMU 11.0.2 et Gondolin 0.12.0 ont été installés après décision explicite, uniquement sous `experiments/gondolin/`. Le package Pi principal exclut ce répertoire.

Trois runs de frontières ont confirmé :

- aucun montage hôte et canary hôte invisible ;
- écritures guest fonctionnelles ;
- HTTP/HTTPS bloqués ;
- zéro connexion et zéro octet vers un serveur TCP hôte contrôlé ;
- DNS synthétique ;
- timeout fermant le processus VM et rejet de toute exécution suivante.

Deux continuations de code appariées ont ensuite réussi nominal + erreur dans des VM neuves. Le code généré n’a jamais été exécuté sur l’hôte. Le handoff a consommé 1 325–1 697 tokens contre 20 946–21 705 pour le contexte natif sur cette fixture.

Enfin, une extension Pi de laboratoire remplace uniquement `bash` lorsque Pi est lancé avec `--tools bash`. Son RPC sans provider charge la VM et évalue la fixture. Deux sessions agentiques ont ensuite réussi avec 4 puis 5 tool calls, tous accompagnés de l’attestation `sandbox=gondolin`, `hostMounts=0`, `network=deny`; une commande extension indépendante confirme nominal + erreur après chaque agent.

L’extension enregistre cette capacité seulement tant que la VM est vivante. `policy-gate confirm` classe alors le shell R1 : le corpus de 16 opérations passe de 68,75 % à 0 % de confirmations, et une session agentique `confirm` réussit avec 4/4 résultats attestés. Dès que l’attestation devient inactive, les classifications R2/R3 d’origine reviennent.

## Décision

Le backend et les routages `bash/read/write/edit` passent le laboratoire technique. Deux runs structurés utilisent exactement `read → edit → bash` sous policy `confirm`, avec 3/3 résultats attestés et vérification indépendante verte. L’export preview est validé dans l’éditeur Pi. Deux workflows complets importent chacun deux fichiers explicitement listés, exécutent `read → edit → bash` dans la VM, puis appliquent un seul fichier après une seconde confirmation. Les tests refusent chemins sensibles, symlinks, plan altéré et source hôte concurrente ; aucun code produit n’est exécuté sur l’hôte. Les cinq cas comportementaux restants passent ensuite dans des VM séparées, sans application hôte ; le cas Git repose toutefois sur un shim de statut minimal, et deux cas sont des outliers tokens. Enfin, deux runs sur quatre fichiers réels explicitement autorisés réparent une régression injectée uniquement dans la copie : suite Node et probe indépendant passent, 11/11 résultats sont attestés et le projet source reste byte-identical. Une paire supplémentaire compare compaction native et handoff sur la même tâche : les deux passent, tandis que le handoff réduit le contexte par un facteur 119,4, les tokens de 80,3 % et la durée de 27 %. La cause du bypass RPC est confirmée dans Pi 0.80.10 et une proposition amont est préparée sans être appliquée ; le patch minimal de parité ne suffit pas si un handler lève une exception. Aucune extension Gondolin n’est configurée globalement. L’exception Unlicense est approuvée et le profil RPC est déployé avec wrappers atomiques, manifeste hash-pinné, refus des deux entrées RPC directes et rollback obligatoire avant `pi update`. Le profil déployé borne aussi les prompts à 100 000 caractères, les appels d’outils modèle à 64 et la session à 10 minutes. Toute nouvelle liste projet devra conserver la même autorisation explicite. Voir `docs/unlicense-review.md` et `docs/pi-rpc-bash-upstream-proposal.md`.

Le gate de friction de `policy-gate` reste en échec ; un sandbox valide ne transforme pas une regex en frontière de sécurité.
