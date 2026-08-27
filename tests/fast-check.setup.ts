import fc from "fast-check";

import { propertyParameters } from "./fast-check-config";

fc.configureGlobal(propertyParameters());
