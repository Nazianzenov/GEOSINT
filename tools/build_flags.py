#!/usr/bin/env python3
"""GeOSINT - flag gallery builder.

Replaces the flag gallery in wiki/docs/identify/flags.md with canonical flags
fetched from Wikimedia Commons (the authoritative, law-sourced reference cited
on the page). Each flag is downloaded once into wiki/docs/assets/flags/ under a
clean, uniform name  <iso2>_<slug>.svg  (e.g. cn_china.svg, sy_syria.svg) and
the gallery markdown is regenerated between the GEOHINTS:flags markers.

Why Wikimedia, not GeoHints, for flags: Commons keeps each
Flag_of_<Country>.svg current (e.g. Syria's Dec-2024 change, Afghanistan 2021),
and the source filename is verifiable. GeoHints' flag set had stale/duplicate
entries (Afghanistan and Syria each appeared twice with no disambiguation).

Filename scheme: lowercase ISO-3166-1 alpha-2 code + "_" + ASCII slug of the
country name. Sortable, byte-stable, no apostrophes/accents/articles. The map
data (country -> code -> Commons file) is the single source of truth below.

Politeness: Wikimedia asks for a descriptive User-Agent and reasonable rates.
We sleep between fetches and skip anything already cached, so a re-run makes no
network calls. Run:  .venv\\Scripts\\python tools\\build_flags.py
"""
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import wikimedia as wm                     # unified resilient Wikimedia client

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "wiki" / "docs"
PAGE = DOCS / "identify" / "flags.md"
ASSETS = DOCS / "assets" / "flags"
START = "<!-- GEOHINTS:flags START -->"
END = "<!-- GEOHINTS:flags END -->"

# continent -> list of (display name, ISO-3166-1 alpha-2, Commons filename).
# Sovereign UN states (+ Taiwan, Palestine, Vatican, Kosovo) grouped per the
# wiki's six-continent scheme.
FLAGS = {
    "Africa": [
        ("Algeria", "dz", "Flag_of_Algeria.svg"), ("Angola", "ao", "Flag_of_Angola.svg"),
        ("Benin", "bj", "Flag_of_Benin.svg"), ("Botswana", "bw", "Flag_of_Botswana.svg"),
        ("Burkina Faso", "bf", "Flag_of_Burkina_Faso.svg"), ("Burundi", "bi", "Flag_of_Burundi.svg"),
        ("Cameroon", "cm", "Flag_of_Cameroon.svg"), ("Cape Verde", "cv", "Flag_of_Cape_Verde.svg"),
        ("Central African Republic", "cf", "Flag_of_the_Central_African_Republic.svg"),
        ("Chad", "td", "Flag_of_Chad.svg"), ("Comoros", "km", "Flag_of_the_Comoros.svg"),
        ("Côte d'Ivoire", "ci", "Flag_of_Côte_d'Ivoire.svg"),
        ("DR Congo", "cd", "Flag_of_the_Democratic_Republic_of_the_Congo.svg"),
        ("Djibouti", "dj", "Flag_of_Djibouti.svg"), ("Egypt", "eg", "Flag_of_Egypt.svg"),
        ("Equatorial Guinea", "gq", "Flag_of_Equatorial_Guinea.svg"),
        ("Eritrea", "er", "Flag_of_Eritrea.svg"), ("Eswatini", "sz", "Flag_of_Eswatini.svg"),
        ("Ethiopia", "et", "Flag_of_Ethiopia.svg"), ("Gabon", "ga", "Flag_of_Gabon.svg"),
        ("Gambia", "gm", "Flag_of_The_Gambia.svg"), ("Ghana", "gh", "Flag_of_Ghana.svg"),
        ("Guinea", "gn", "Flag_of_Guinea.svg"), ("Guinea-Bissau", "gw", "Flag_of_Guinea-Bissau.svg"),
        ("Kenya", "ke", "Flag_of_Kenya.svg"), ("Lesotho", "ls", "Flag_of_Lesotho.svg"),
        ("Liberia", "lr", "Flag_of_Liberia.svg"), ("Libya", "ly", "Flag_of_Libya.svg"),
        ("Madagascar", "mg", "Flag_of_Madagascar.svg"), ("Malawi", "mw", "Flag_of_Malawi.svg"),
        ("Mali", "ml", "Flag_of_Mali.svg"), ("Mauritania", "mr", "Flag_of_Mauritania.svg"),
        ("Mauritius", "mu", "Flag_of_Mauritius.svg"), ("Morocco", "ma", "Flag_of_Morocco.svg"),
        ("Mozambique", "mz", "Flag_of_Mozambique.svg"), ("Namibia", "na", "Flag_of_Namibia.svg"),
        ("Niger", "ne", "Flag_of_Niger.svg"), ("Nigeria", "ng", "Flag_of_Nigeria.svg"),
        ("Republic of the Congo", "cg", "Flag_of_the_Republic_of_the_Congo.svg"),
        ("Rwanda", "rw", "Flag_of_Rwanda.svg"),
        ("São Tomé and Príncipe", "st", "Flag_of_Sao_Tome_and_Principe.svg"),
        ("Senegal", "sn", "Flag_of_Senegal.svg"), ("Seychelles", "sc", "Flag_of_Seychelles.svg"),
        ("Sierra Leone", "sl", "Flag_of_Sierra_Leone.svg"), ("Somalia", "so", "Flag_of_Somalia.svg"),
        ("South Africa", "za", "Flag_of_South_Africa.svg"),
        ("South Sudan", "ss", "Flag_of_South_Sudan.svg"), ("Sudan", "sd", "Flag_of_Sudan.svg"),
        ("Tanzania", "tz", "Flag_of_Tanzania.svg"), ("Togo", "tg", "Flag_of_Togo.svg"),
        ("Tunisia", "tn", "Flag_of_Tunisia.svg"), ("Uganda", "ug", "Flag_of_Uganda.svg"),
        ("Zambia", "zm", "Flag_of_Zambia.svg"), ("Zimbabwe", "zw", "Flag_of_Zimbabwe.svg"),
    ],
    "Asia": [
        ("Afghanistan", "af", "Flag_of_the_Taliban.svg"), ("Armenia", "am", "Flag_of_Armenia.svg"),
        ("Azerbaijan", "az", "Flag_of_Azerbaijan.svg"), ("Bahrain", "bh", "Flag_of_Bahrain.svg"),
        ("Bangladesh", "bd", "Flag_of_Bangladesh.svg"), ("Bhutan", "bt", "Flag_of_Bhutan.svg"),
        ("Brunei", "bn", "Flag_of_Brunei.svg"), ("Cambodia", "kh", "Flag_of_Cambodia.svg"),
        ("China", "cn", "Flag_of_the_People's_Republic_of_China.svg"),
        ("Cyprus", "cy", "Flag_of_Cyprus.svg"), ("Georgia", "ge", "Flag_of_Georgia.svg"),
        ("India", "in", "Flag_of_India.svg"), ("Indonesia", "id", "Flag_of_Indonesia.svg"),
        ("Iran", "ir", "Flag_of_Iran.svg"), ("Iraq", "iq", "Flag_of_Iraq.svg"),
        ("Israel", "il", "Flag_of_Israel.svg"), ("Japan", "jp", "Flag_of_Japan.svg"),
        ("Jordan", "jo", "Flag_of_Jordan.svg"), ("Kazakhstan", "kz", "Flag_of_Kazakhstan.svg"),
        ("Kuwait", "kw", "Flag_of_Kuwait.svg"), ("Kyrgyzstan", "kg", "Flag_of_Kyrgyzstan.svg"),
        ("Laos", "la", "Flag_of_Laos.svg"), ("Lebanon", "lb", "Flag_of_Lebanon.svg"),
        ("Malaysia", "my", "Flag_of_Malaysia.svg"), ("Maldives", "mv", "Flag_of_Maldives.svg"),
        ("Mongolia", "mn", "Flag_of_Mongolia.svg"), ("Myanmar", "mm", "Flag_of_Myanmar.svg"),
        ("Nepal", "np", "Flag_of_Nepal.svg"), ("North Korea", "kp", "Flag_of_North_Korea.svg"),
        ("Oman", "om", "Flag_of_Oman.svg"), ("Pakistan", "pk", "Flag_of_Pakistan.svg"),
        ("Palestine", "ps", "Flag_of_Palestine.svg"),
        ("Philippines", "ph", "Flag_of_the_Philippines.svg"), ("Qatar", "qa", "Flag_of_Qatar.svg"),
        ("Saudi Arabia", "sa", "Flag_of_Saudi_Arabia.svg"), ("Singapore", "sg", "Flag_of_Singapore.svg"),
        ("South Korea", "kr", "Flag_of_South_Korea.svg"), ("Sri Lanka", "lk", "Flag_of_Sri_Lanka.svg"),
        ("Syria", "sy", "Flag_of_Syria.svg"), ("Taiwan", "tw", "Flag_of_the_Republic_of_China.svg"),
        ("Tajikistan", "tj", "Flag_of_Tajikistan.svg"), ("Thailand", "th", "Flag_of_Thailand.svg"),
        ("Timor-Leste", "tl", "Flag_of_East_Timor.svg"), ("Turkey", "tr", "Flag_of_Turkey.svg"),
        ("Turkmenistan", "tm", "Flag_of_Turkmenistan.svg"),
        ("United Arab Emirates", "ae", "Flag_of_the_United_Arab_Emirates.svg"),
        ("Uzbekistan", "uz", "Flag_of_Uzbekistan.svg"), ("Vietnam", "vn", "Flag_of_Vietnam.svg"),
        ("Yemen", "ye", "Flag_of_Yemen.svg"),
    ],
    "Europe": [
        ("Albania", "al", "Flag_of_Albania.svg"), ("Andorra", "ad", "Flag_of_Andorra.svg"),
        ("Austria", "at", "Flag_of_Austria.svg"), ("Belarus", "by", "Flag_of_Belarus.svg"),
        ("Belgium", "be", "Flag_of_Belgium.svg"),
        ("Bosnia and Herzegovina", "ba", "Flag_of_Bosnia_and_Herzegovina.svg"),
        ("Bulgaria", "bg", "Flag_of_Bulgaria.svg"), ("Croatia", "hr", "Flag_of_Croatia.svg"),
        ("Czechia", "cz", "Flag_of_the_Czech_Republic.svg"), ("Denmark", "dk", "Flag_of_Denmark.svg"),
        ("Estonia", "ee", "Flag_of_Estonia.svg"), ("Finland", "fi", "Flag_of_Finland.svg"),
        ("France", "fr", "Flag_of_France.svg"), ("Germany", "de", "Flag_of_Germany.svg"),
        ("Greece", "gr", "Flag_of_Greece.svg"), ("Hungary", "hu", "Flag_of_Hungary.svg"),
        ("Iceland", "is", "Flag_of_Iceland.svg"), ("Ireland", "ie", "Flag_of_Ireland.svg"),
        ("Italy", "it", "Flag_of_Italy.svg"), ("Kosovo", "xk", "Flag_of_Kosovo.svg"),
        ("Latvia", "lv", "Flag_of_Latvia.svg"), ("Liechtenstein", "li", "Flag_of_Liechtenstein.svg"),
        ("Lithuania", "lt", "Flag_of_Lithuania.svg"), ("Luxembourg", "lu", "Flag_of_Luxembourg.svg"),
        ("Malta", "mt", "Flag_of_Malta.svg"), ("Moldova", "md", "Flag_of_Moldova.svg"),
        ("Monaco", "mc", "Flag_of_Monaco.svg"), ("Montenegro", "me", "Flag_of_Montenegro.svg"),
        ("Netherlands", "nl", "Flag_of_the_Netherlands.svg"),
        ("North Macedonia", "mk", "Flag_of_North_Macedonia.svg"), ("Norway", "no", "Flag_of_Norway.svg"),
        ("Poland", "pl", "Flag_of_Poland.svg"), ("Portugal", "pt", "Flag_of_Portugal.svg"),
        ("Romania", "ro", "Flag_of_Romania.svg"), ("Russia", "ru", "Flag_of_Russia.svg"),
        ("San Marino", "sm", "Flag_of_San_Marino.svg"), ("Serbia", "rs", "Flag_of_Serbia.svg"),
        ("Slovakia", "sk", "Flag_of_Slovakia.svg"), ("Slovenia", "si", "Flag_of_Slovenia.svg"),
        ("Spain", "es", "Flag_of_Spain.svg"), ("Sweden", "se", "Flag_of_Sweden.svg"),
        ("Switzerland", "ch", "Flag_of_Switzerland.svg"), ("Ukraine", "ua", "Flag_of_Ukraine.svg"),
        ("United Kingdom", "gb", "Flag_of_the_United_Kingdom.svg"),
        ("Vatican City", "va", "Flag_of_Vatican_City.svg"),
    ],
    "North America": [
        ("Antigua and Barbuda", "ag", "Flag_of_Antigua_and_Barbuda.svg"),
        ("Bahamas", "bs", "Flag_of_the_Bahamas.svg"), ("Barbados", "bb", "Flag_of_Barbados.svg"),
        ("Belize", "bz", "Flag_of_Belize.svg"), ("Canada", "ca", "Flag_of_Canada.svg"),
        ("Costa Rica", "cr", "Flag_of_Costa_Rica.svg"), ("Cuba", "cu", "Flag_of_Cuba.svg"),
        ("Dominica", "dm", "Flag_of_Dominica.svg"),
        ("Dominican Republic", "do", "Flag_of_the_Dominican_Republic.svg"),
        ("El Salvador", "sv", "Flag_of_El_Salvador.svg"), ("Grenada", "gd", "Flag_of_Grenada.svg"),
        ("Guatemala", "gt", "Flag_of_Guatemala.svg"), ("Haiti", "ht", "Flag_of_Haiti.svg"),
        ("Honduras", "hn", "Flag_of_Honduras.svg"), ("Jamaica", "jm", "Flag_of_Jamaica.svg"),
        ("Mexico", "mx", "Flag_of_Mexico.svg"), ("Nicaragua", "ni", "Flag_of_Nicaragua.svg"),
        ("Panama", "pa", "Flag_of_Panama.svg"),
        ("Saint Kitts and Nevis", "kn", "Flag_of_Saint_Kitts_and_Nevis.svg"),
        ("Saint Lucia", "lc", "Flag_of_Saint_Lucia.svg"),
        ("Saint Vincent and the Grenadines", "vc", "Flag_of_Saint_Vincent_and_the_Grenadines.svg"),
        ("Trinidad and Tobago", "tt", "Flag_of_Trinidad_and_Tobago.svg"),
        ("United States", "us", "Flag_of_the_United_States.svg"),
    ],
    "Oceania": [
        ("Australia", "au", "Flag_of_Australia.svg"), ("Fiji", "fj", "Flag_of_Fiji.svg"),
        ("Kiribati", "ki", "Flag_of_Kiribati.svg"),
        ("Marshall Islands", "mh", "Flag_of_the_Marshall_Islands.svg"),
        ("Micronesia", "fm", "Flag_of_the_Federated_States_of_Micronesia.svg"),
        ("Nauru", "nr", "Flag_of_Nauru.svg"), ("New Zealand", "nz", "Flag_of_New_Zealand.svg"),
        ("Palau", "pw", "Flag_of_Palau.svg"), ("Papua New Guinea", "pg", "Flag_of_Papua_New_Guinea.svg"),
        ("Samoa", "ws", "Flag_of_Samoa.svg"),
        ("Solomon Islands", "sb", "Flag_of_the_Solomon_Islands.svg"), ("Tonga", "to", "Flag_of_Tonga.svg"),
        ("Tuvalu", "tv", "Flag_of_Tuvalu.svg"), ("Vanuatu", "vu", "Flag_of_Vanuatu.svg"),
    ],
    "South America": [
        ("Argentina", "ar", "Flag_of_Argentina.svg"), ("Bolivia", "bo", "Flag_of_Bolivia.svg"),
        ("Brazil", "br", "Flag_of_Brazil.svg"), ("Chile", "cl", "Flag_of_Chile.svg"),
        ("Colombia", "co", "Flag_of_Colombia.svg"), ("Ecuador", "ec", "Flag_of_Ecuador.svg"),
        ("Guyana", "gy", "Flag_of_Guyana.svg"), ("Paraguay", "py", "Flag_of_Paraguay.svg"),
        ("Peru", "pe", "Flag_of_Peru.svg"), ("Suriname", "sr", "Flag_of_Suriname.svg"),
        ("Uruguay", "uy", "Flag_of_Uruguay.svg"), ("Venezuela", "ve", "Flag_of_Venezuela.svg"),
    ],
}


def slug(name):
    """ASCII, lowercase, hyphenless slug: 'Côte d'Ivoire' -> 'cote_divoire'."""
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    s = s.lower().replace("'", "").replace(".", "")
    out = []
    for ch in s:
        out.append(ch if ch.isalnum() else "_")
    s = "".join(out)
    while "__" in s:
        s = s.replace("__", "_")
    return s.strip("_")


def local_name(iso2, display):
    return f"{iso2}_{slug(display)}.svg"


def download(filename, dest):
    """Fetch a known Commons flag file via the unified client: resolve its real
    upload URL (imageinfo, not throttled) then download with polite backoff."""
    url = wm.file_url(filename)
    if not url:
        raise LookupError(f"Commons file not found: {filename}")
    wm.download(url, dest)
    return True


def main():
    ASSETS.mkdir(parents=True, exist_ok=True)
    fetched = skipped = failed = 0
    sections = []
    for continent, items in FLAGS.items():
        figs = []
        for disp, iso2, fname in sorted(items, key=lambda x: x[0].lower()):
            local = ASSETS / local_name(iso2, disp)
            if not local.is_file():
                try:
                    download(fname, local)
                    fetched += 1
                    print(f"  fetched  {disp:32} -> {local.name}")
                except Exception as e:
                    failed += 1
                    print(f"  FAIL {disp} ({fname}): {e}")
                    continue
            else:
                skipped += 1
            rel = "../assets/flags/" + local.name
            figs.append(f'<figure><img src="{rel}" loading="lazy" alt="Flag of {disp}">'
                        f"<figcaption>{disp}</figcaption></figure>")
        sections.append(f'### {continent}\n\n<div class="gh-gallery">\n'
                        + "\n".join(figs) + "\n</div>")

    gallery = (
        f"{START}\n\n"
        "<style>\n"
        ".gh-gallery { display: flex; flex-wrap: wrap; gap: 14px; }\n"
        ".gh-gallery figure { margin: 0; width: 160px; }\n"
        ".gh-gallery img { width: 160px; border: 1px solid var(--md-default-fg-color--lightest); border-radius: 3px; }\n"
        ".gh-gallery figcaption { font-size: .72rem; text-align: center; }\n"
        "</style>\n\n"
        "## Flag gallery — current sovereign-state flags\n\n"
        "Flags from [Wikimedia Commons](https://commons.wikimedia.org/) "
        "(authoritative, sourced to national law), cached locally — the wiki works offline.\n\n"
        + "\n\n".join(sections)
        + f"\n\n{END}"
    )

    text = PAGE.read_text(encoding="utf-8")
    i, j = text.find(START), text.find(END)
    if i < 0 or j < 0:
        print("ERROR: GEOHINTS:flags markers not found in flags.md")
        return 1
    text = text[:i] + gallery + text[j + len(END):]
    PAGE.write_text(text, encoding="utf-8")
    n = sum(1 for _ in ASSETS.glob("*.svg"))
    print(f"done: {fetched} fetched, {skipped} already cached, {failed} failed. "
          f"Flags: wiki/docs/assets/flags ({n} files)")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
