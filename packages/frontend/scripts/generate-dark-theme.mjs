import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';

const sourceDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const output = join(sourceDir, 'dark-theme.generated.css');
const files = readdirSync(sourceDir).filter(name => name.endsWith('.css') &&
	!name.startsWith('dark-theme.') && !name.includes('print'));
const mainImports = [...readFileSync(join(sourceDir, 'main.tsx'), 'utf8').matchAll(/import '\.\/(.+?\.css)'/g)]
	.map(match => match[1]);
files.sort((left, right) => {
	const leftIndex = mainImports.indexOf(left), rightIndex = mainImports.indexOf(right);
	return (leftIndex < 0 ? 1000 : leftIndex) - (rightIndex < 0 ? 1000 : rightIndex) || left.localeCompare(right);
});

function hsl(r, g, b) {
	const max = Math.max(r, g, b), min = Math.min(r, g, b), diff = max - min;
	const l = (max + min) / 2;
	if (!diff) return { h: 0, s: 0, l };
	const s = diff / (1 - Math.abs(2 * l - 1));
	const h = max === r ? ((g - b) / diff) % 6 : max === g ? (b - r) / diff + 2 : (r - g) / diff + 4;
	return { h: (h * 60 + 360) % 360, s, l };
}

function darkColor(red, green, blue, kind) {
	const { h, s, l } = hsl(red / 255, green / 255, blue / 255);
	// The app uses many low-saturation blue-grays for neutral ink and surfaces.
	// Keep these neutral; saturated blue links and action buttons retain their hue.
	const neutral = s < .16 || (h >= 190 && h <= 250 && s < .55);
	if (kind === 'text') {
		if (neutral) return l > .82 ? '#f8fafc' : l > .57 ? '#aebdd0' : l > .31 ? '#b9c6d7' : '#e5edf8';
		return `hsl(${Math.round(h)} ${Math.round(Math.max(55, Math.min(s * 100, 90)))}% ${l > .75 ? 78 : 72}%)`;
	}
	if (kind === 'border') {
		if (neutral) return l > .63 ? '#34445a' : '#526178';
		return `hsl(${Math.round(h)} ${Math.round(Math.min(s * 100, 65))}% ${l > .75 ? 37 : 53}%)`;
	}
	if (neutral) {
		if (l > .985) return '#202c3d'; // raised white cards
		if (l > .92) return '#172233'; // pale page and alternating rows
		if (l > .78) return '#29384d';
		if (l > .57) return '#334155';
		return `rgb(${red} ${green} ${blue})`; // existing dark navigation
	}
	if (l > .72) return `hsl(${Math.round(h)} ${Math.round(Math.min(s * 100, 55))}% 22%)`;
	if (l > .55) return `hsl(${Math.round(h)} ${Math.round(Math.min(s * 100, 65))}% 29%)`;
	return `rgb(${red} ${green} ${blue})`; // strong action buttons
}

function mapColorToken(token, kind) {
	let hex = token.slice(1);
	if (hex.length === 3 || hex.length === 4) hex = [...hex].map(char => char + char).join('');
	if (hex.length !== 6 && hex.length !== 8) return token;
	const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
	const alpha = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
	if (alpha < .3) return token;
	const mapped = darkColor(r, g, b, kind);
	return alpha === 1 ? mapped : `color-mix(in srgb, ${mapped} ${Math.round(alpha * 100)}%, transparent)`;
}

function colorKind(property) {
	if (property.startsWith('--') || property.includes('shadow')) return null;
	if (property === 'color' || property === 'fill' || property === 'stroke' || property === 'caret-color') return 'text';
	if (property.startsWith('border') || property.startsWith('outline') || property === 'text-decoration-color') return 'border';
	if (property.startsWith('background')) return 'background';
	return null;
}

function mapValue(value, kind) {
	if (value.includes('url(')) return value;
	let mapped = value.replace(/#[\da-f]{3,8}\b/gi, token => mapColorToken(token, kind));
	mapped = mapped.replace(/\brgba?\(\s*(\d{1,3})\s*,?\s*(\d{1,3})\s*,?\s*(\d{1,3})(?:\s*[,/]\s*([\d.]+))?\s*\)/gi,
		(token, red, green, blue, alpha) => {
			if (alpha !== undefined && Number(alpha) < .3) return token;
			const color = darkColor(Number(red), Number(green), Number(blue), kind);
			return alpha === undefined ? color : `color-mix(in srgb, ${color} ${Math.round(Number(alpha) * 100)}%, transparent)`;
		});
	return mapped;
}

function splitSelectors(selector) {
	const parts = []; let start = 0, depth = 0;
	for (let i = 0; i < selector.length; i++) {
		if (selector[i] === '(' || selector[i] === '[') depth++;
		else if (selector[i] === ')' || selector[i] === ']') depth--;
		else if (selector[i] === ',' && depth === 0) { parts.push(selector.slice(start, i).trim()); start = i + 1; }
	}
	parts.push(selector.slice(start).trim());
	return parts;
}

function darkSelector(selector) {
	if (/^:root(?=\b|[.#[\s:])/i.test(selector)) return selector.replace(/^:root/, 'html[data-theme="dark"]');
	if (/^html(?=\b|[.#[\s:])/i.test(selector)) return selector.replace(/^html/, 'html[data-theme="dark"]');
	return `html[data-theme="dark"] ${selector}`;
}

let rules = 0;
const generated = postcss.root();
for (const file of files) {
	const source = postcss.parse(readFileSync(join(sourceDir, file), 'utf8'), { from: file });
	source.walkRules(rule => {
		let ancestor = rule.parent, skip = false;
		while (ancestor && ancestor.type !== 'root') {
			if (ancestor.type === 'atrule' && (/^(?:keyframes|font-face)$/i.test(ancestor.name) ||
				(ancestor.name === 'media' && /print/i.test(ancestor.params)))) { skip = true; break; }
			ancestor = ancestor.parent;
		}
		if (skip) return;
		const nextRule = postcss.rule({ selector: splitSelectors(rule.selector).map(darkSelector).join(', ') });
		rule.walkDecls(decl => {
			const kind = colorKind(decl.prop);
			if (!kind) return;
			const value = mapValue(decl.value, kind);
			if (value !== decl.value) nextRule.append(postcss.decl({ prop: decl.prop, value, important: decl.important }));
		});
		if (!nextRule.nodes?.length) return;
		let node = nextRule;
		ancestor = rule.parent;
		while (ancestor && ancestor.type !== 'root') {
			if (ancestor.type === 'atrule') {
				const outer = postcss.atRule({ name: ancestor.name, params: ancestor.params });
				outer.append(node); node = outer;
			}
			ancestor = ancestor.parent;
		}
		generated.append(node); rules++;
	});
}
const css = `/* Generated by scripts/${basename(fileURLToPath(import.meta.url))}; do not edit. */\n` +
	`@media screen {\n${generated.toString()}\n}\n`;
writeFileSync(output, css);
console.log(`Generated ${rules} dark-theme rules from ${files.length} stylesheets.`);
