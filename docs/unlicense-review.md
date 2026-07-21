# Revue technique Unlicense — `tweetnacl@0.14.5`

Date de revue : 20 juillet 2026. Décision de politique explicite : 21 juillet 2026. Cette note ne constitue pas un avis juridique.

## Périmètre exact

La dépendance est de production, non optionnelle dans le lockfile du sous-package expérimental :

```text
@earendil-works/gondolin@0.12.0
└─ ssh2@1.17.0
   └─ bcrypt-pbkdf@1.0.2
      └─ tweetnacl@0.14.5
```

`bcrypt-pbkdf` importe `tweetnacl.lowlevel.crypto_hash`. Ce n’est donc pas uniquement une métadonnée inutilisée.

Empreintes de l’artefact installé :

- tarball npm : intégrité lockfile `sha512-KXXFFdAbFXY4geFIwoyNK+f5Z1b7swfXABfL7HXCmoIWMKU3dmS26672A4EeQtDzLKy7SXmfBu51JolvEKwtGA==` ;
- `LICENSE` SHA-256 : `88d9b4eb60579c191ec391ca04c16130572d7eedc4a86daa58bf28c6e14c9bcd` ;
- `package.json` SHA-256 : `4d4e7122e483ab7bed48c884bb0de1471d3cb3753e1a334e3aafa3c32c22923e` ;
- fichier runtime `nacl-fast.js` SHA-256 : `432333a18cef679d16c71328fcc18cc547e58d7d1c2b880a581b2d7ee4248027`.

## Lecture de la licence fournie

Le texte installé :

- dédie le logiciel au domaine public lorsque la juridiction le permet ;
- autorise copie, modification, publication, utilisation, compilation, vente et distribution, commerciale ou non ;
- ne contient aucune obligation de publication du code source ou de réciprocité réseau ;
- exclut garanties et responsabilité ;
- ne contient pas de clause explicite de concession de brevets ;
- ne fournit pas, dans cet artefact, une licence permissive de repli séparée si la dédicace au domaine public n’est pas pleinement reconnue.

Il ne s’agit ni d’AGPL, ni de SSPL, ni de BSL. Le risque n’est donc pas un copyleft interdit, mais l’incertitude juridique de la dédicace au domaine public selon les juridictions, notamment autour de droits qui ne sont pas intégralement renonçables, et l’absence de concession de brevets explicite.

## Compatibilité technique et souveraineté

- Aucun appel réseau de `tweetnacl` n’est identifié ; la bibliothèque s’exécute localement.
- La licence n’impose ni service tiers, ni transfert de données, ni télémétrie.
- L’artefact a été obtenu via le registre npm pendant l’installation explicitement autorisée ; aucune donnée projet n’a été transmise par le sandbox.
- Pour un usage distribué, l’avis de licence devrait être conservé dans le dossier des notices même en l’absence d’obligation d’attribution, par traçabilité.

## Options

1. **Exception limitée** : accepter explicitement `tweetnacl@0.14.5` avec les empreintes ci-dessus pour Gondolin 0.12.0 seulement.
2. **Remplacement amont** : supprimer la chaîne `ssh2 → bcrypt-pbkdf → tweetnacl` dans Gondolin ou obtenir une variante sous licence whitelistée. Cette option demande un changement amont et une nouvelle évaluation.
3. **Rester en laboratoire** : conserver l’acceptation actuelle sans distribution ni activation globale.

Le vendoring local ne résout pas l’incertitude de licence et n’est pas recommandé comme contournement.

## Décision actuelle

**Exception limitée approuvée explicitement le 21 juillet 2026.** L’option 1 est retenue uniquement pour `@earendil-works/gondolin@0.12.0` et `tweetnacl@0.14.5` aux empreintes ci-dessus. Cette décision :

- n’approuve aucune autre version ni autre dépendance Unlicense ;
- doit être réévaluée si une version, une empreinte ou la chaîne de dépendances change ;
- conserve l’avis de licence par traçabilité ;
- n’infère aucune concession de brevets ;
- accepte explicitement l’incertitude juridictionnelle décrite dans cette revue.

La décision machine-readable est `experiments/gondolin/license-exception.json`.
