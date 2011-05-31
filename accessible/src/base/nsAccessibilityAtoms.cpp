/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is mozilla.org code.
 *
 * The Initial Developer of the Original Code is
 * Netscape Communications Corporation.
 * Portions created by the Initial Developer are Copyright (C) 2003
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Original Author: Aaron Leventhal (aaronl@netscape.com)
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either of the GNU General Public License Version 2 or later (the "GPL"),
 * or the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

#include "nsAccessibilityAtoms.h"
#include "nsStaticAtom.h"
#include "nsMemory.h"

// define storage for all accessibility atoms
#define ACCESSIBILITY_ATOM(_name, _value) nsIAtom* nsAccessibilityAtoms::_name;
#include "nsAccessibilityAtomList.h"
#undef ACCESSIBILITY_ATOM

#define ACCESSIBILITY_ATOM(name_, value_) NS_STATIC_ATOM_BUFFER(name_##_buffer, value_)
#include "nsAccessibilityAtomList.h"
#undef ACCESSIBILITY_ATOM

static const nsStaticAtom atomInfo[] = {
#define ACCESSIBILITY_ATOM(name_, value_) NS_STATIC_ATOM(name_##_buffer, &nsAccessibilityAtoms::name_),
#include "nsAccessibilityAtomList.h"
#undef ACCESSIBILITY_ATOM
};

void nsAccessibilityAtoms::AddRefAtoms()
{
  NS_RegisterStaticAtoms(atomInfo, NS_ARRAY_LENGTH(atomInfo));
}
 