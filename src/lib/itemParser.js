function parseKeyValue(line) {
  const idx = line.indexOf(':');
  if (idx === -1) return null;
  return { key: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() };
}

function parseRequirements(lines) {
  const req = {};
  for (const line of lines) {
    const kv = parseKeyValue(line);
    if (!kv) continue;
    const k = kv.key.toLowerCase();
    const num = parseInt(kv.value, 10);
    if (k === 'level') req.level = num;
    if (k === 'str') req.strength = num;
    if (k === 'dex') req.dexterity = num;
    if (k === 'int') req.intelligence = num;
  }
  return Object.keys(req).length ? req : null;
}

function parseQuality(value) {
  const m = value.match(/\+?(\d+)%/);
  return m ? parseInt(m[1], 10) : null;
}

function parseInfluence(text) {
  const influences = [];
  if (/Shaper Item/i.test(text)) influences.push('Shaper');
  if (/Crusader Item/i.test(text)) influences.push('Crusader');
  if (/Hunter Item/i.test(text)) influences.push('Hunter');
  if (/Redeemer Item/i.test(text)) influences.push('Redeemer');
  if (/Warlord Item/i.test(text)) influences.push('Warlord');
  if (/Elder Item/i.test(text)) influences.push('Elder');
  // Eldritch implicits use distinct inventory glow (searing / tangled)
  if (/Searing Exarch Item/i.test(text)) influences.push('Exarch');
  if (/Eater of Worlds Item/i.test(text)) influences.push('Eater');
  return influences;
}

function detectGame(text) {
  if (/Rune:/i.test(text) || /Charm Slots:/i.test(text)) return 'poe2';
  return 'poe1';
}

/** Normalize Advanced Description values: +156(140-159) / 80.3(64.1-96) → rolled value;
 *  hybrid 2nd lines often paste as (16-17)% with no rolled number — use range max. */
export function normalizeModText(line) {
  return line
    .replace(/(\d+(?:\.\d+)?)\((\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)\)/g, '$1')
    .replace(/\((\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)\)/g, '$2')
    .replace(/\s*\((augmented|crafted|fractured|desecrated|enchant|implicit|veiled)\)\s*/gi, '')
    .trim();
}

const ADVANCED_HEADER =
  /^\{\s*(?<kind>Fractured|Unveiled|Veiled|Master Crafted|Crafted|Implicit|Enchantment|Enchant)?\s*(?<gen>Prefix|Suffix)?\s*Modifier(?:\s+"(?<name>[^"]+)")?(?:\s*\((?:Tier|Rank):\s*(?<tier>\d+)\))?(?:\s*[—–-]\s*(?<tags>[^}]+))?\s*\}$/i;

const SIMPLE_PREFIX_HINTS = [
  /to maximum Life$/i,
  /to maximum Mana$/i,
  /to maximum Energy Shield$/i,
  /increased Physical Damage$/i,
  /Adds .+ Damage$/i,
  /to Level of .+ Gems$/i,
  /Penetrate .+ Resistance$/i,
  /increased Spell Damage$/i,
];

const SIMPLE_SUFFIX_HINTS = [
  /to .+ Resistance$/i,
  /to (Strength|Dexterity|Intelligence)$/i,
  /to all Attributes$/i,
  /Critical Strike Multiplier$/i,
  /increased Critical Strike Chance$/i,
  /increased Attack Speed$/i,
  /increased Cast Speed$/i,
  /increased Movement Speed$/i,
  /of the Essence/i,
];

/**
 * Approximate PoE StatDescription rank (lower = higher on tooltip).
 * Used when Advanced paste order differs from the normal client tooltip.
 * Fractured/crafted buckets are applied separately (see sortExplicitModsForTooltip).
 */
const TOOLTIP_STAT_RANKS = [
  /adds .+ (physical|fire|cold|lightning|chaos|elemental) damage/i,
  /increased physical damage/i,
  /increased (fire|cold|lightning|chaos|elemental|spell|projectile|area) damage/i,
  /increased attack speed/i,
  /increased cast speed/i,
  /increased (global )?critical strike chance/i,
  /critical strike (chance for spells|multiplier)/i,
  /accuracy rating/i,
  /penetrate .+ resistance/i,
  /as (extra|Extra) .+ [Dd]amage/i,
  /to maximum (life|mana|energy shield)/i,
  /increased (maximum )?(life|mana|energy shield)/i,
  /to (strength|dexterity|intelligence|all attributes)/i,
  /to .+ resistance/i,
  /increased movement speed/i,
];

function tooltipStatRank(text) {
  const line = String(text ?? '').split('\n')[0].trim();
  const i = TOOLTIP_STAT_RANKS.findIndex((r) => r.test(line));
  return i === -1 ? 9000 : i;
}

/**
 * Match GGG trade/API + Path of Building tooltip buckets:
 * fractured → natural explicits → crafted (hybrids stay one entry).
 * Within fractured/natural, sort by StatDescription-like rank (not prefix→suffix;
 * GGG does not order by generation type on the normal tooltip).
 */
export function sortExplicitModsForTooltip(mods) {
  const decorated = (mods ?? []).map((m, i) => ({ m, i, rank: tooltipStatRank(m.text) }));
  decorated.sort((a, b) => {
    const group = (x) => (x.m.crafted ? 3 : x.m.fractured ? 1 : 2);
    const ga = group(a);
    const gb = group(b);
    if (ga !== gb) return ga - gb;
    if (ga < 3 && a.rank !== b.rank) return a.rank - b.rank;
    return a.i - b.i;
  });
  return decorated.map((d) => d.m);
}

function classifySimple(text) {
  if (SIMPLE_PREFIX_HINTS.some((r) => r.test(text))) return 'prefix';
  if (SIMPLE_SUFFIX_HINTS.some((r) => r.test(text))) return 'suffix';
  return 'unknown';
}

function headerIsCrafted(kind, line) {
  // Master Crafted / Crafted headers, or Rank (bench crafts use Rank, not Tier)
  return (
    kind.includes('crafted') ||
    /\bMaster\s+Crafted\b/i.test(line) ||
    /\{\s*Crafted\b/i.test(line) ||
    /\(Rank:\s*\d+\)/i.test(line)
  );
}

function parseAdvancedHeader(line) {
  const m = line.trim().match(ADVANCED_HEADER);
  if (!m) {
    // Implicit / Enchant / Crafted without full Prefix|Suffix|Tier shape
    const loose = line
      .trim()
      .match(
        /^\{\s*(?<kind>Implicit|Enchantment|Enchant|Fractured|Veiled|Unveiled|Master Crafted|Crafted)?\s*(?<gen>Prefix|Suffix)?\s*(?:Modifier)?(?:\s+"(?<name>[^"]+)")?(?:\s*\((?:Tier|Rank):\s*(?<tier>\d+)\))?(?:\s*[—–-]\s*(?<tags>[^}]+))?\s*\}$/i
      );
    if (!loose) return null;
    const kind = (loose.groups?.kind ?? '').toLowerCase();
    const genRaw = (loose.groups?.gen ?? '').toLowerCase();
    const tags = (loose.groups?.tags ?? '')
      .split(/[,—–-]/)
      .map((t) => t.trim())
      .filter((t) => t && !/^\d+%/.test(t) && !/increased/i.test(t));
    return {
      gen: genRaw === 'prefix' ? 'prefix' : genRaw === 'suffix' ? 'suffix' : null,
      name: loose.groups?.name ?? null,
      tier: loose.groups?.tier ? parseInt(loose.groups.tier, 10) : null,
      tags,
      fractured: kind.includes('fractured'),
      crafted: headerIsCrafted(kind, line),
      veiled: kind.includes('veiled') || kind.includes('unveiled'),
      enchant: kind.includes('enchant'),
      implicit: kind.includes('implicit'),
      ofEssence: false,
    };
  }

  const kind = (m.groups?.kind ?? '').toLowerCase();
  const genRaw = (m.groups?.gen ?? '').toLowerCase();
  const tagStr = m.groups?.tags ?? '';
  const tags = tagStr
    .split(',')
    .map((t) => t.replace(/—.*$/, '').trim())
    .filter((t) => t && !/^\d+%/.test(t) && !/^increased$/i.test(t));

  const name = m.groups?.name ?? null;
  return {
    gen: genRaw === 'prefix' ? 'prefix' : genRaw === 'suffix' ? 'suffix' : null,
    name,
    tier: m.groups?.tier ? parseInt(m.groups.tier, 10) : null,
    tags,
    fractured: kind.includes('fractured'),
    crafted: headerIsCrafted(kind, line),
    veiled: kind.includes('veiled') || kind.includes('unveiled'),
    enchant: kind.includes('enchant'),
    implicit: kind.includes('implicit'),
    ofEssence: /of the Essence/i.test(name ?? ''),
  };
}

function isStatLine(line) {
  return /^(Armour|Evasion|Energy Shield|Physical Damage|Chaos Damage|Elemental Damage|Critical Strike Chance|Attacks per Second|Weapon Range|Quality|Wand|Claw|Bow|Staff):/i.test(
    line
  );
}

/** PoE magic naming: "PrefixName BaseName of SuffixName" / "BaseName of the X" → BaseName. */
function stripMagicItemName(name) {
  let s = String(name ?? '').trim();
  if (!s) return s;
  // Suffix affix: "… of X" / "… of the X" (possibly multi-word suffix names)
  s = s.replace(/\s+of\s+(?:the\s+)?[A-Za-z][\w'-]*(?:\s+[A-Za-z][\w'-]*)*$/i, '').trim();
  return s || String(name).trim();
}

function isMetaFooter(line) {
  return /^(Fractured Item|Split|Mirrored|Corrupted|Synthesised Item|Note:|Searing Exarch Item|Eater of Worlds Item|Shaper Item|Elder Item|Crusader Item|Hunter Item|Redeemer Item|Warlord Item)$/i.test(
    line
  );
}

function hasAdvancedFormat(text) {
  return /\{\s*.*Modifier/i.test(text) || /\{\s*Implicit Modifier/i.test(text);
}

function parseAdvancedMods(sections) {
  const implicits = [];
  const enchants = [];
  const explicitMods = [];
  let itemLevel = null;
  let quality = null;
  let requirements = null;
  let sockets = null;

  for (const section of sections.slice(1)) {
    const lines = section.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    const first = lines[0];

    if (/^Requirements:/i.test(first)) {
      requirements = parseRequirements(lines.slice(1));
      continue;
    }
    if (/^Sockets:/i.test(first)) {
      sockets = first.replace(/^Sockets:\s*/i, '');
      continue;
    }
    if (/^Item Level:/i.test(first)) {
      itemLevel = parseInt(first.replace(/\D/g, ''), 10);
      continue;
    }
    if (/^Quality:/i.test(first) && lines.length === 1) {
      quality = parseQuality(first);
      continue;
    }
    if (isStatLine(first) && !lines.some((l) => l.startsWith('{'))) continue;

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (isMetaFooter(line)) {
        i++;
        continue;
      }
      if (/^Item Level:/i.test(line)) {
        itemLevel = parseInt(line.replace(/\D/g, ''), 10);
        i++;
        continue;
      }
      if (/^Quality:/i.test(line)) {
        quality = parseQuality(line);
        i++;
        continue;
      }
      if (isStatLine(line)) {
        i++;
        continue;
      }

      // Enchant without braces
      if (/\(enchant\)/i.test(line)) {
        enchants.push({
          text: normalizeModText(line),
          raw: line,
          type: 'enchant',
          gen: null,
          tags: [],
          tier: null,
          name: null,
          crafted: false,
          fractured: false,
          veiled: false,
          ofEssence: false,
          enchant: true,
          implicit: false,
        });
        i++;
        continue;
      }

      if (line.startsWith('{')) {
        const header = parseAdvancedHeader(line);
        i++;
        const valueLines = [];
        while (i < lines.length && !lines[i].startsWith('{') && !isMetaFooter(lines[i])) {
          if (!isStatLine(lines[i]) && !/^Item Level:/i.test(lines[i])) {
            valueLines.push(lines[i]);
          }
          i++;
        }
        if (!header || !valueLines.length) continue;

        const text = valueLines.map(normalizeModText).join('\n');
        const valueJoined = valueLines.join('\n');
        const entry = {
          text,
          raw: [line, ...valueLines].join('\n'),
          type: header.implicit ? 'implicit' : header.enchant ? 'enchant' : header.gen ?? classifySimple(text),
          gen: header.gen ?? (header.implicit || header.enchant ? null : classifySimple(text)),
          tags: header.tags,
          tier: header.tier,
          name: header.name,
          crafted: header.crafted || /\(crafted\)/i.test(valueJoined),
          fractured: header.fractured || /\(fractured\)/i.test(valueJoined),
          veiled: header.veiled || /\(veiled\)/i.test(valueJoined),
          ofEssence: header.ofEssence || /of the Essence/i.test(header.name ?? ''),
          enchant: header.enchant,
          implicit: header.implicit,
        };

        if (header.implicit) implicits.push(entry);
        else if (header.enchant) enchants.push(entry);
        else explicitMods.push(entry);
        continue;
      }

      i++;
    }
  }

  return { implicits, enchants, explicitMods, itemLevel, quality, requirements, sockets };
}

function parseSimpleMods(sections) {
  const implicits = [];
  const enchants = [];
  const explicitMods = [];
  let itemLevel = null;
  let quality = null;
  let requirements = null;
  let sockets = null;

  for (let si = 1; si < sections.length; si++) {
    const lines = sections[si].split(/\r?\n/).filter(Boolean);
    const first = lines[0] ?? '';

    if (/^Requirements:/i.test(first)) {
      requirements = parseRequirements(lines.slice(1));
      continue;
    }
    if (/^Sockets:/i.test(first)) {
      sockets = first.replace(/^Sockets:\s*/i, '');
      continue;
    }
    if (/^Item Level:/i.test(first)) {
      itemLevel = parseInt(first.replace(/\D/g, ''), 10);
      continue;
    }
    if (/^Quality:/i.test(first)) {
      quality = parseQuality(first);
      continue;
    }

    for (const line of lines) {
      if (/^Item Level:/i.test(line)) {
        itemLevel = parseInt(line.replace(/\D/g, ''), 10);
        continue;
      }
      if (isStatLine(line) || isMetaFooter(line)) continue;
      if (/^Level:\s*\d+/i.test(line)) continue;

      const text = normalizeModText(line);
      if (!text || text.length < 3) continue;

      if (/\(enchant\)/i.test(line)) {
        enchants.push({
          text,
          raw: line,
          type: 'enchant',
          gen: null,
          tags: [],
          tier: null,
          name: null,
          crafted: false,
          fractured: false,
          veiled: false,
          ofEssence: false,
          enchant: true,
          implicit: false,
        });
        continue;
      }

      const entry = {
        text,
        raw: line.trim(),
        type: line.includes('(implicit)') ? 'implicit' : classifySimple(text),
        gen: line.includes('(implicit)') ? null : classifySimple(text),
        tags: [],
        tier: null,
        name: null,
        crafted: /\(crafted\)/i.test(line),
        fractured: /\(fractured\)/i.test(line),
        veiled: /\(veiled\)/i.test(line),
        ofEssence: false,
        enchant: false,
        implicit: line.includes('(implicit)'),
      };

      if (entry.implicit) implicits.push(entry);
      else explicitMods.push(entry);
    }
  }

  return { implicits, enchants, explicitMods, itemLevel, quality, requirements, sockets };
}

function detectCannotRollHints(implicits, enchants, explicitMods) {
  const texts = [];
  for (const list of [implicits, enchants, explicitMods]) {
    for (const m of list ?? []) texts.push(typeof m === 'string' ? m : m?.text ?? '');
  }
  const blob = texts.join('\n');
  const blockedTags = [];
  if (/Cannot roll Caster Modifiers/i.test(blob)) blockedTags.push('caster');
  if (/Cannot roll Attack Modifiers/i.test(blob)) blockedTags.push('attack');
  let maxRequiredLevel = null;
  const lvl = blob.match(/Cannot roll Modifiers with Required Level above (\d+)/i);
  if (lvl) maxRequiredLevel = parseInt(lvl[1], 10);
  return {
    blockedTags,
    maxRequiredLevel,
    texts: texts.filter((t) => /Cannot roll /i.test(t)),
  };
}

export function parseItem(text) {
  const raw = text.trim();
  if (!raw) throw new Error('Paste an item copied from Path of Exile (Ctrl+C in game).');

  const game = detectGame(raw);
  const sections = raw.split(/\r?\n--------\r?\n/);
  const header = sections[0]?.split(/\r?\n/) ?? [];
  const meta = {};
  const nameLines = [];

  for (const line of header) {
    const kv = parseKeyValue(line);
    if (kv) {
      const key = kv.key.toLowerCase();
      if (key === 'item class') meta.itemClass = kv.value;
      else if (key === 'rarity') meta.rarity = kv.value;
      else meta[kv.key] = kv.value;
    } else if (line.trim() && !isStatLine(line.trim())) {
      nameLines.push(line.trim());
    }
  }

  const rarity = meta.rarity ?? 'Unknown';
  let baseName = nameLines.at(-1) ?? 'Unknown Base';
  let itemName = nameLines.length > 1 ? nameLines.slice(0, -1).join(' ') : null;

  // Header may include item class name like "Wand" as a lone line — skip weapon type lines
  const skipNames = new Set(['Wand', 'Claw', 'Bow', 'Staff', 'Dagger', 'Sceptre', 'Ring', 'Amulet', 'Belt']);
  if (skipNames.has(baseName) && nameLines.length >= 2) {
    baseName = nameLines.at(-2);
    itemName = nameLines.length > 2 ? nameLines.slice(0, -2).join(' ') : null;
  }

  // Magic items fold affix names into the single name line: "Prefix Base of the Suffix"
  if (/^magic$/i.test(rarity) && nameLines.length === 1) {
    baseName = stripMagicItemName(baseName);
    itemName = null;
  }

  const advanced = hasAdvancedFormat(raw);
  const parsed = advanced ? parseAdvancedMods(sections) : parseSimpleMods(sections);

  // Also scan header section for quality / item type lines already handled
  for (const line of header) {
    if (/^Quality:/i.test(line) && !parsed.quality) parsed.quality = parseQuality(line);
  }

  const explicitMods = parsed.explicitMods.map((m) => ({
    ...m,
    type: m.gen ?? m.type,
  }));

  const prefixes = explicitMods.filter((m) => m.gen === 'prefix' && !m.crafted);
  const suffixes = explicitMods.filter((m) => m.gen === 'suffix' && !m.crafted);
  const unknown = explicitMods.filter((m) => (!m.gen || m.gen === 'unknown') && !m.crafted && !m.implicit);
  const crafted = explicitMods.filter((m) => m.crafted);
  const cannotRoll = detectCannotRollHints(parsed.implicits, parsed.enchants, explicitMods);

  return {
    game,
    itemClass: meta.itemClass ?? 'Unknown',
    rarity,
    itemName,
    baseName,
    itemLevel: parsed.itemLevel,
    quality: parsed.quality,
    requirements: parsed.requirements,
    sockets: parsed.sockets,
    corrupted: /Corrupted/i.test(raw),
    synthesised: /Synthesised/i.test(raw),
    fracturedItem: /Fractured Item/i.test(raw) || explicitMods.some((m) => m.fractured),
    influenced: parseInfluence(raw),
    implicits: parsed.implicits,
    enchants: parsed.enchants,
    explicitMods,
    prefixes,
    suffixes,
    unknown,
    crafted,
    cannotRoll,
    modCount: explicitMods.filter((m) => !m.crafted).length,
    advancedFormat: advanced,
  };
}
